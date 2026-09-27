import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertExistingPathIdentity, bindContainedDestination } from '../../core/contained-filesystem';
import { getLifecycleOperationLockPath, LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME } from './lifecycle-lock';

export interface LifecycleLockHandoff {
    schemaVersion: 1;
    parentPid: number;
    lockId: string;
    hostname: string;
    targetRoot: string;
    acquiredAtUtc: string;
    ownerIdentity: string;
}

function readUpdateLockOwner(targetRoot: string, ownerPid: number): LifecycleLockHandoff {
    const root = path.resolve(targetRoot);
    const ownerPath = path.join(getLifecycleOperationLockPath(root), LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME);
    const binding = bindContainedDestination(root, ownerPath);
    if (binding.missingAt) throw new Error('Lifecycle lock handoff requires an existing owner file.');
    const descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let owner: Record<string, unknown>;
    try {
        const stat = fs.fstatSync(descriptor, { bigint: true });
        const identity = binding.existing[binding.existing.length - 1];
        if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== identity.dev || stat.ino !== identity.ino
            || stat.mode !== identity.mode || stat.birthtimeNs !== identity.birthtimeNs) {
            throw new Error('Lifecycle lock handoff owner identity changed while opening.');
        }
        owner = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
        assertExistingPathIdentity(binding);
    } finally {
        fs.closeSync(descriptor);
    }
    const acquiredAt = typeof owner?.acquired_at_utc === 'string' ? Date.parse(owner.acquired_at_utc) : NaN;
    if (!owner || owner.pid !== ownerPid || owner.operation !== 'update'
        || typeof owner.lock_id !== 'string' || !owner.lock_id.trim()
        || typeof owner.hostname !== 'string' || owner.hostname.trim().toLowerCase() !== os.hostname().trim().toLowerCase()
        || typeof owner.target_root !== 'string' || !owner.target_root.trim()
        || path.relative(root, path.resolve(owner.target_root)) !== ''
        || !Number.isFinite(acquiredAt) || acquiredAt > Date.now()) {
        throw new Error('Lifecycle lock handoff does not belong to the expected active update owner.');
    }
    try {
        process.kill(ownerPid, 0);
    } catch (error) {
        throw new Error('Lifecycle lock handoff owner is no longer alive or cannot be verified.', { cause: error });
    }
    return {
        schemaVersion: 1, parentPid: ownerPid, lockId: owner.lock_id,
        hostname: owner.hostname.trim().toLowerCase(), targetRoot: root,
        acquiredAtUtc: owner.acquired_at_utc as string,
        ownerIdentity: createHash('sha256').update(JSON.stringify(binding.existing,
            (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).digest('hex')
    };
}

export function captureLifecycleLockHandoff(targetRoot: string): LifecycleLockHandoff {
    const owner = readUpdateLockOwner(targetRoot, process.pid);
    if (Date.parse(owner.acquiredAtUtc) < Math.floor(performance.timeOrigin)) {
        throw new Error('Lifecycle lock handoff owner predates the current parent process.');
    }
    return owner;
}

export function assertLifecycleLockHandoff(targetRoot: string, handoff: unknown): LifecycleLockHandoff {
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
        throw new Error('Lifecycle lock handoff requires the exact parent owner proof.');
    }
    const expected = readUpdateLockOwner(targetRoot, process.ppid);
    const received = handoff as Record<string, unknown>;
    if (Object.entries(expected).some(([key, value]) => received[key] !== value)) {
        throw new Error('Lifecycle lock handoff no longer matches the parent update generation.');
    }
    return expected;
}
