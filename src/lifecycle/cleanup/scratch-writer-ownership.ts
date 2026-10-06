import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { assertContainedDestination, assertExistingPathIdentity, bindContainedDestination,
    ensureContainedDirectory, writeContainedFile, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { acquireFilesystemLock, inspectFilesystemLock, releaseFilesystemLock } from '../../gate-runtime/task-events-locking';
import { isProcessLikelyAlive } from '../../gate-runtime/timeline/task-events-locking-metadata';
import { validateTargetRoot } from '../lifecycle-common';
import { withLifecycleRuntimeMutationGeneration } from '../runtime-mutation-generation';
import { isProtectedGenericScratchName } from './runtime-cleanup-ownership';

export interface ScratchWriterOptions {
    targetRoot: string;
    bundleRoot: string;
    scratchName: string;
}

export interface ScratchWriterLocations {
    root: string;
    bundleRoot: string;
    runtimeDir: string;
    tmpDir: string;
    scratchPath: string;
    ownerDirectory: string;
    ownerPath: string;
    lockPath: string;
}

export interface ScratchWriterRecord {
    schema_version: 1;
    kind: 'scratch_writer_registration';
    registration_id: string;
    scratch_relative_path: string;
    root_creation_identity: string;
    pid: number;
    hostname: string;
    registered_at_utc: string;
}

export interface ScratchWriterRegistration {
    scratchPath: string;
    ownerPath: string;
    registrationId: string;
}

export interface ScratchFileSnapshot {
    binding: ContainedDestination;
    identity: string;
    sha256: string;
    bytes: number;
    mtimeMs: number;
    contents?: Buffer;
}

export interface ScratchWriterInspection {
    owner: ScratchWriterRecord;
    file: ScratchFileSnapshot;
    state: 'live' | 'dead' | 'unknown' | 'foreign';
}

export const SCRATCH_CLEANUP_LIMITS = Object.freeze({
    selectedRoots: 64, entries: 4096, pathDepth: 64, pathCharacters: 4096,
    ownerBytes: 16 * 1024, fileBytes: 64 * 1024 * 1024, treeBytes: 128 * 1024 * 1024,
    snapshotBytes: 8 * 1024 * 1024, revalidationChecks: 65536
});
const FILE_READ_CHUNK_BYTES = 128 * 1024;
const WRITER_LOCK_TIMEOUT_MS = 50;
const WRITER_RECORD_KEYS = ['schema_version', 'kind', 'registration_id', 'scratch_relative_path',
    'root_creation_identity', 'pid', 'hostname', 'registered_at_utc'];
const REGISTRATION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export function scratchSha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

export function scratchPathKey(value: string): string {
    const normalized = path.resolve(value).replace(/\\/gu, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function scratchBindingIdentity(binding: ContainedDestination): string {
    return scratchSha256(JSON.stringify(binding.existing.map(item => [scratchPathKey(item.path),
        String(item.dev), String(item.ino), String(item.mode), String(item.birthtimeNs)])));
}

export function scratchStatIdentity(stat: fs.BigIntStats): string {
    return scratchSha256(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.nlink, stat.size,
        stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].map(String)));
}

function rootCreationIdentity(rootPath: string): string {
    const stat = lstatFileIdentitySync(rootPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.birthtimeNs <= 0n) {
        throw new Error('Scratch root requires an unlinked directory with a verifiable creation identity.');
    }
    return scratchSha256(JSON.stringify([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]));
}

function assertScratchName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name === '.' || name === '..'
        || /[\\/\u0000-\u001f<>:"|?*]/u.test(name) || /[. ]$/u.test(name)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
        || isProtectedGenericScratchName(name)) {
        throw new Error('Scratch name must be one portable, non-task, unprotected tmp root name.');
    }
}

export function resolveScratchWriterLocations(options: ScratchWriterOptions): ScratchWriterLocations {
    if (!options || typeof options.targetRoot !== 'string' || typeof options.bundleRoot !== 'string') {
        throw new Error('Scratch registration requires explicit workspace and bundle roots.');
    }
    assertScratchName(options.scratchName);
    const root = validateTargetRoot(options.targetRoot, options.bundleRoot), bundleRoot = path.resolve(options.bundleRoot);
    if (scratchPathKey(bundleRoot) !== scratchPathKey(path.join(root, 'garda-agent-orchestrator'))) {
        throw new Error('Scratch cleanup requires the canonical workspace orchestrator bundle root.');
    }
    const bundle = bindContainedDestination(root, bundleRoot);
    if (bundle.missingAt !== null) throw new Error('Scratch cleanup requires an existing contained orchestrator bundle.');
    const runtimeDir = path.join(bundleRoot, 'runtime'), tmpDir = path.join(runtimeDir, 'tmp');
    const scratchPath = path.join(tmpDir, options.scratchName), ownerDirectory = path.join(runtimeDir, 'scratch-writers');
    return { root, bundleRoot, runtimeDir, tmpDir, scratchPath, ownerDirectory,
        ownerPath: path.join(ownerDirectory, `${scratchSha256(scratchPathKey(scratchPath))}.json`),
        lockPath: path.join(runtimeDir, '.scratch-writers.lock') };
}

function assertStableScratchRead(binding: ContainedDestination, before: fs.BigIntStats,
    descriptor: number, bytes: number): void {
    const identity = scratchStatIdentity(before);
    if (bytes !== Number(before.size) || scratchStatIdentity(fs.fstatSync(descriptor, { bigint: true })) !== identity
        || scratchStatIdentity(lstatFileIdentitySync(binding.path, { bigint: true })) !== identity) {
        throw new Error('Scratch file bytes or identity changed during its bounded read.');
    }
    assertContainedDestination(binding);
}

export function readScratchFile(binding: ContainedDestination, maximumBytes: number, capture = false): ScratchFileSnapshot {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > SCRATCH_CLEANUP_LIMITS.fileBytes
        || capture && maximumBytes > SCRATCH_CLEANUP_LIMITS.ownerBytes) {
        throw new Error('Scratch read allowance must be finite and bounded; captured writer metadata has its own smaller cap.');
    }
    assertContainedDestination(binding);
    const before = lstatFileIdentitySync(binding.path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
        throw new Error('Scratch member must be a bounded regular unshared file.');
    }
    const identity = scratchStatIdentity(before), hash = createHash('sha256');
    const descriptor = fs.openSync(binding.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(FILE_READ_CHUNK_BYTES, Number(before.size) + 1));
    let bytes = 0;
    try {
        if (scratchStatIdentity(fs.fstatSync(descriptor, { bigint: true })) !== identity) {
            throw new Error('Scratch file identity changed while opening its descriptor.');
        }
        for (let read = fs.readSync(descriptor, buffer, 0, buffer.length, null); read > 0;
            read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) {
            bytes += read;
            if (bytes > maximumBytes || bytes > Number(before.size)) throw new Error('Scratch file grew beyond its retained read allowance.');
            hash.update(buffer.subarray(0, read));
            if (capture) chunks.push(Buffer.from(buffer.subarray(0, read)));
        }
        assertStableScratchRead(binding, before, descriptor, bytes);
        return { binding, identity, sha256: hash.digest('hex'), bytes,
            mtimeMs: Number(before.mtimeNs) / 1e6, ...(capture ? { contents: Buffer.concat(chunks) } : {}) };
    } finally { fs.closeSync(descriptor); }
}

function hasRegisteredWriterIdentity(owner: ScratchWriterRecord): boolean {
    return typeof owner.registration_id === 'string' && REGISTRATION_ID_PATTERN.test(owner.registration_id)
        && typeof owner.scratch_relative_path === 'string' && typeof owner.root_creation_identity === 'string'
        && /^[0-9a-f]{64}$/u.test(owner.root_creation_identity);
}

function hasRegisteredWriterProcess(owner: ScratchWriterRecord): boolean {
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string'
        && owner.hostname.trim().length > 0 && owner.hostname.length <= 255
        && typeof owner.registered_at_utc === 'string' && Number.isFinite(Date.parse(owner.registered_at_utc))
        && new Date(owner.registered_at_utc).toISOString() === owner.registered_at_utc;
}

function parseWriterRecord(file: ScratchFileSnapshot): ScratchWriterRecord {
    let owner: ScratchWriterRecord;
    try { owner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.contents)); }
    catch { throw new Error('Scratch owner registration is malformed; preserve it and inspect the writer record.'); }
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || Object.keys(owner).sort().join('|') !== [...WRITER_RECORD_KEYS].sort().join('|')
        || owner.schema_version !== 1 || owner.kind !== 'scratch_writer_registration'
        || !hasRegisteredWriterIdentity(owner) || !hasRegisteredWriterProcess(owner)) {
        throw new Error('Scratch owner registration has an unverifiable schema; inspect it without assuming inactivity.');
    }
    return owner;
}

export function inspectScratchWriter(locations: ScratchWriterLocations): ScratchWriterInspection {
    const scratch = bindContainedDestination(locations.root, locations.scratchPath);
    if (scratch.missingAt !== null) throw new Error('Scratch root is missing; obtain a fresh exact preview.');
    const ownerBinding = bindContainedDestination(locations.root, locations.ownerPath);
    if (ownerBinding.missingAt !== null) throw new Error('Scratch owner registration is missing; preserve legacy scratch and register a new root explicitly.');
    const file = readScratchFile(ownerBinding, SCRATCH_CLEANUP_LIMITS.ownerBytes, true), owner = parseWriterRecord(file);
    const relative = path.relative(locations.runtimeDir, locations.scratchPath).replace(/\\/gu, '/');
    const expectedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (owner.scratch_relative_path !== expectedRelative || owner.root_creation_identity !== rootCreationIdentity(locations.scratchPath)) {
        throw new Error('Scratch owner registration conflicts with the exact path or root creation identity; preserve the replacement.');
    }
    assertContainedDestination(scratch);
    if (owner.hostname.toLowerCase() !== os.hostname().toLowerCase()) return { owner, file, state: 'foreign' };
    const alive = isProcessLikelyAlive(owner.pid);
    return { owner, file, state: alive === true ? 'live' : alive === false ? 'dead' : 'unknown' };
}

export function assertScratchLockRecoverySafe(root: string, lockPath: string, allowLive = false): void {
    const binding = bindContainedDestination(root, lockPath);
    if (binding.missingAt !== null) return;
    const ownerBinding = bindContainedDestination(root, path.join(lockPath, 'owner.json'));
    if (ownerBinding.missingAt !== null) throw new Error('Scratch cleanup lock owner is missing; inspect the lock before recovery.');
    const owner = readScratchFile(ownerBinding, SCRATCH_CLEANUP_LIMITS.ownerBytes);
    const inspected = inspectFilesystemLock(lockPath);
    if (inspected.metadata.metadata_status !== 'ok' || !inspected.metadata.lock_id
        || inspected.metadata.pid === null || inspected.ownerHostMatchesCurrent !== true
        || (inspected.ownerAlive !== false && !(allowLive && inspected.ownerAlive === true))) {
        throw new Error('Scratch cleanup lock has an active, foreign or unverifiable owner; only known-dead local recovery is allowed.');
    }
    assertContainedDestination(binding);
    assertContainedDestination(ownerBinding);
    const current = readScratchFile(ownerBinding, SCRATCH_CLEANUP_LIMITS.ownerBytes);
    if (current.identity !== owner.identity || current.sha256 !== owner.sha256) {
        throw new Error('Scratch cleanup lock owner changed during recovery inspection.');
    }
}

export function withScratchWriterLock<T>(locations: ScratchWriterLocations, callback: (checkLock: () => void) => T): T {
    const runtime = bindContainedDestination(locations.root, locations.runtimeDir);
    ensureContainedDirectory(locations.root, locations.runtimeDir);
    assertExistingPathIdentity(runtime);
    assertScratchLockRecoverySafe(locations.root, locations.lockPath);
    const { handle } = acquireFilesystemLock(locations.lockPath, { timeoutMs: WRITER_LOCK_TIMEOUT_MS,
        requireKnownDeadOwner: true, allowForeignHostStaleRecovery: false, ownerLabel: 'scratch-writer' });
    try {
        assertExistingPathIdentity(runtime);
        const owner = readScratchFile(bindContainedDestination(locations.root, path.join(handle.lockPath, 'owner.json')),
            SCRATCH_CLEANUP_LIMITS.ownerBytes, true);
        const metadata = JSON.parse(owner.contents!.toString('utf8'));
        if (metadata.lock_id !== handle.lockId || metadata.pid !== process.pid || metadata.hostname !== os.hostname()) {
            throw new Error('Scratch writer lock generation is not owned by the current process.');
        }
        const checkLock = (): void => {
            assertExistingPathIdentity(runtime);
            const current = readScratchFile(owner.binding, SCRATCH_CLEANUP_LIMITS.ownerBytes);
            if (current.identity !== owner.identity || current.sha256 !== owner.sha256) {
                throw new Error('Scratch writer lock ownership changed before mutation.');
            }
        };
        checkLock();
        return callback(checkLock);
    } finally { releaseFilesystemLock(handle); }
}

export function registerScratchWriter(options: ScratchWriterOptions): ScratchWriterRegistration {
    const locations = resolveScratchWriterLocations(options);
    return withScratchWriterLock(locations, checkLock => {
        const scratch = bindContainedDestination(locations.root, locations.scratchPath);
        const ownerBinding = bindContainedDestination(locations.root, locations.ownerPath);
        let previousOwner: ScratchFileSnapshot | null = null;
        if (scratch.missingAt === null) {
            const current = inspectScratchWriter(locations);
            if (current.state !== 'dead') throw new Error(`Scratch writer is ${current.state}; active or unverifiable ownership cannot be replaced.`);
            previousOwner = current.file;
        } else if (ownerBinding.missingAt === null) {
            throw new Error('Scratch name retains a previous owner registration; create a new uniquely named root.');
        }
        return withLifecycleRuntimeMutationGeneration(locations.bundleRoot, 'scratch-writer-registration', () => {
            checkLock();
            ensureContainedDirectory(locations.root, locations.tmpDir);
            ensureContainedDirectory(locations.root, locations.ownerDirectory);
            assertExistingPathIdentity(scratch);
            if (scratch.missingAt !== null) fs.mkdirSync(locations.scratchPath);
            const boundRoot = bindContainedDestination(locations.root, locations.scratchPath);
            const relative = path.relative(locations.runtimeDir, locations.scratchPath).replace(/\\/gu, '/');
            const record: ScratchWriterRecord = { schema_version: 1, kind: 'scratch_writer_registration',
                registration_id: randomUUID(), scratch_relative_path: process.platform === 'win32' ? relative.toLowerCase() : relative,
                root_creation_identity: rootCreationIdentity(locations.scratchPath), pid: process.pid,
                hostname: os.hostname(), registered_at_utc: new Date().toISOString() };
            checkLock(); assertContainedDestination(boundRoot);
            assertExistingPathIdentity(ownerBinding);
            if (previousOwner) {
                const current = readScratchFile(previousOwner.binding, SCRATCH_CLEANUP_LIMITS.ownerBytes);
                if (current.identity !== previousOwner.identity || current.sha256 !== previousOwner.sha256) {
                    throw new Error('Scratch owner registration changed before activation.');
                }
            } else if (bindContainedDestination(locations.root, locations.ownerPath).missingAt === null) {
                throw new Error('Scratch owner registration appeared during root creation; preserve the conflicting owner.');
            }
            writeContainedFile(locations.root, locations.ownerPath, Buffer.from(JSON.stringify(record) + '\n'));
            assertContainedDestination(boundRoot);
            return { scratchPath: locations.scratchPath, ownerPath: locations.ownerPath, registrationId: record.registration_id };
        });
    });
}
