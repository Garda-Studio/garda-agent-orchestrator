import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertContainedDestination, assertExistingPathIdentity, bindContainedDestination, ensureContainedDirectory,
    readBoundedContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { isProcessLikelyAlive } from '../../gate-runtime/timeline/task-events-locking-metadata';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../../gates/task-mode';
import { withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { withLifecycleRuntimeMutationGeneration } from '../runtime-mutation-generation';
import { OWNED_DISPOSABLE_ARTIFACT_CATEGORIES, type OwnedDisposableArtifactInspection,
    type OwnedDisposableArtifactOptions, type OwnedDisposableArtifactRecord,
    type OwnedDisposableArtifactRegistration, type OwnedDisposableArtifactRegistrationOptions,
    type OwnedDisposableArtifactSelection } from './owned-disposable-artifact-contracts';
import { readScratchFile, resolveScratchWriterLocations, scratchBindingIdentity,
    scratchSha256, withScratchWriterLock, type ScratchFileSnapshot, type ScratchWriterLocations } from './scratch-writer-ownership';

const OWNER_BYTES = 16 * 1024;
const TASK_MODE_BYTES = 128 * 1024;
const TIMELINE_BYTES = 4 * 1024 * 1024;
const AUTHORITY_BYTES = 32;
const AUTHENTICATION_DOMAIN = 'garda.owned-disposable-artifact.v1';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const REGISTRATION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const PRODUCER_INSTANCE_ID = randomUUID();
const RECORD_KEYS: readonly (keyof OwnedDisposableArtifactRecord)[] = [
    'schema_version', 'kind', 'registration_id', 'workspace_identity', 'task_id', 'run_id', 'category',
    'payload_relative_path', 'root_creation_identity', 'pid', 'hostname', 'producer_instance_id', 'registered_at_utc',
    'sealed_at_utc', 'authentication_sha256'
];

interface ProducerLocations extends ScratchWriterLocations {
    taskId: string;
    producerDirectory: string;
    authorityPath: string;
    payloadDirectory: string;
    workspaceIdentity: string;
}

function assertInputFields(value: unknown, extraField: 'category' | 'registrationId'): void {
    if (!isPlainRecord(value) || Object.keys(value).sort().join('|')
        !== ['targetRoot', 'bundleRoot', 'taskId', extraField].sort().join('|')) {
        throw new Error('Disposable producer input requires exact declared fields; caller-selected paths or owners are forbidden.');
    }
}

function resolveLocations(options: OwnedDisposableArtifactOptions): ProducerLocations {
    const taskId = assertCanonicalTaskId(options.taskId);
    if (taskId !== options.taskId) throw new Error('Disposable task id must be an exact canonical string.');
    const locations = resolveScratchWriterLocations({ targetRoot: options.targetRoot, bundleRoot: options.bundleRoot,
        scratchName: 'disposable-producer-registry' });
    const bundleBinding = bindContainedDestination(locations.root, locations.bundleRoot);
    const producerDirectory = path.join(locations.runtimeDir, 'disposable-producers');
    return { ...locations, taskId, producerDirectory, authorityPath: path.join(producerDirectory, '.authority-key'),
        payloadDirectory: path.join(locations.runtimeDir, 'owned-disposable'),
        workspaceIdentity: scratchSha256(scratchBindingIdentity(bundleBinding)) };
}

function readCurrentRun(locations: ProducerLocations): string {
    const modePath = path.join(locations.runtimeDir, 'reviews', `${locations.taskId}-task-mode.json`);
    const timelinePath = path.join(locations.runtimeDir, 'task-events', `${locations.taskId}.jsonl`);
    const modeBinding = bindContainedDestination(locations.root, modePath);
    const timelineBinding = bindContainedDestination(locations.root, timelinePath);
    if (modeBinding.missingAt !== null || timelineBinding.missingAt !== null) {
        throw new Error('Disposable registration requires an existing native task entry and timeline.');
    }
    const mode = readScratchFile(modeBinding, TASK_MODE_BYTES);
    const timeline = readScratchFile(timelineBinding, TIMELINE_BYTES);
    const runId = withTaskTimelineReadSnapshot(path.dirname(timelinePath), locations.taskId, () => {
        let entryHash: string | null = null;
        const integrity = inspectTaskEventFile(timelinePath, locations.taskId, { onIntegrityEvent: event => {
            if (event.event_type === 'TASK_MODE_ENTERED') {
                entryHash = event.outcome === 'PASS'
                    ? String((event.integrity as Record<string, unknown>).event_sha256) : null;
            }
            if (event.event_type === 'TASK_RESET' || event.event_type === 'TASK_BLOCKED') entryHash = null;
        } });
        const evidence = getTaskModeEvidence(locations.root, locations.taskId);
        const violations = getTaskModeEvidenceViolations(evidence);
        if (integrity.status !== 'PASS' || !entryHash || !HASH_PATTERN.test(entryHash)
            || violations.length || evidence.evidence_hash !== mode.sha256) {
            throw new Error(`Disposable registration requires an intact current native task entry and timeline: ${violations.join('; ') || integrity.status}.`);
        }
        return scratchSha256(JSON.stringify([entryHash, mode.sha256]));
    });
    for (const snapshot of [mode, timeline]) {
        const current = readScratchFile(snapshot.binding, snapshot === mode ? TASK_MODE_BYTES : TIMELINE_BYTES);
        if (current.identity !== snapshot.identity || current.sha256 !== snapshot.sha256) {
            throw new Error('Native task run evidence changed during disposable ownership inspection.');
        }
    }
    return runId;
}

function readAuthoritySnapshot(locations: ProducerLocations, create: boolean): ScratchFileSnapshot {
    const binding = bindContainedDestination(locations.root, locations.authorityPath);
    if (binding.missingAt !== null) {
        if (!create) throw new Error('Disposable registration authority is missing; preserve records and payload.');
        const directory = bindContainedDestination(locations.root, locations.producerDirectory);
        if (directory.missingAt === null && readBoundedContainedDirectory(directory, 1).length) {
            throw new Error('Disposable authority is missing from an existing registry; do not replace its authority.');
        }
        ensureContainedDirectory(locations.root, locations.producerDirectory);
        assertContainedDestination(bindContainedDestination(locations.root, locations.authorityPath));
        const descriptor = fs.openSync(locations.authorityPath, 'wx', 0o600);
        try {
            assertExistingPathIdentity(binding);
            const created = bindContainedDestination(locations.root, locations.authorityPath);
            const opened = fs.fstatSync(descriptor, { bigint: true }), named = lstatFileIdentitySync(created.path, { bigint: true });
            if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1n
                || process.platform !== 'win32' && (opened.mode & 0o077n) !== 0n) {
                throw new Error('Disposable authority identity changed before its private write.');
            }
            fs.writeFileSync(descriptor, randomBytes(AUTHORITY_BYTES));
            fs.fsyncSync(descriptor);
            assertContainedDestination(created);
        } finally { fs.closeSync(descriptor); }
    }
    const snapshot = readScratchFile(bindContainedDestination(locations.root, locations.authorityPath), AUTHORITY_BYTES, true);
    if (snapshot.bytes !== AUTHORITY_BYTES || process.platform !== 'win32'
        && (fs.lstatSync(locations.authorityPath).mode & 0o077) !== 0) {
        throw new Error('Disposable authority must be an exact private regular key file.');
    }
    return snapshot;
}

function readAuthority(locations: ProducerLocations, create: boolean): Buffer {
    return readAuthoritySnapshot(locations, create).contents!;
}

function authentication(record: OwnedDisposableArtifactRecord, key: Buffer): Buffer {
    const unsigned = Object.fromEntries(RECORD_KEYS.filter(field => field !== 'authentication_sha256')
        .map(field => [field, record[field]]));
    return createHmac('sha256', key).update(JSON.stringify({ domain: AUTHENTICATION_DOMAIN, record: unsigned })).digest();
}

function isCanonicalTime(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseRecord(contents: Buffer): OwnedDisposableArtifactRecord {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)); }
    catch { throw new Error('Disposable producer registration is malformed JSON.'); }
    if (!isPlainRecord(value) || Object.keys(value).sort().join('|') !== [...RECORD_KEYS].sort().join('|')
        || value.schema_version !== 1 || value.kind !== 'owned_disposable_artifact'
        || typeof value.registration_id !== 'string' || !REGISTRATION_PATTERN.test(value.registration_id)
        || !['workspace_identity', 'run_id', 'root_creation_identity', 'authentication_sha256']
            .every(field => typeof value[field] === 'string' && HASH_PATTERN.test(value[field] as string))
        || typeof value.task_id !== 'string' || typeof value.payload_relative_path !== 'string'
        || !OWNED_DISPOSABLE_ARTIFACT_CATEGORIES.includes(value.category as never)
        || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
        || typeof value.hostname !== 'string' || !value.hostname.trim() || value.hostname.length > 255
        || typeof value.producer_instance_id !== 'string' || !REGISTRATION_PATTERN.test(value.producer_instance_id)
        || !isCanonicalTime(value.registered_at_utc)
        || value.sealed_at_utc !== null && (!isCanonicalTime(value.sealed_at_utc)
            || value.sealed_at_utc < value.registered_at_utc)) {
        throw new Error('Disposable producer registration has an unverifiable schema.');
    }
    return value as unknown as OwnedDisposableArtifactRecord;
}

function producerPaths(locations: ProducerLocations, runId: string, registrationId: string) {
    if (typeof registrationId !== 'string' || !REGISTRATION_PATTERN.test(registrationId)) {
        throw new Error('Disposable registration id must be a native UUID.');
    }
    return { ownerPath: path.join(locations.producerDirectory, locations.taskId, `${registrationId}.json`),
        payloadPath: path.join(locations.payloadDirectory, locations.taskId, runId, registrationId) };
}

export interface OwnedDisposableArtifactOwnerInspection extends OwnedDisposableArtifactInspection {
    ownerFile: ScratchFileSnapshot;
    authorityIdentity: string;
}

function inspectRegistrationOwner(locations: ProducerLocations, registrationId: string): OwnedDisposableArtifactOwnerInspection {
    const runId = readCurrentRun(locations), paths = producerPaths(locations, runId, registrationId);
    const ownerBinding = bindContainedDestination(locations.root, paths.ownerPath);
    if (ownerBinding.missingAt !== null) {
        throw new Error('Disposable producer registration is missing; preserve the orphan payload.');
    }
    const owner = readScratchFile(ownerBinding, OWNER_BYTES, true);
    const record = parseRecord(owner.contents!);
    const authority = readAuthoritySnapshot(locations, false);
    const signature = authentication(record, authority.contents!);
    if (!timingSafeEqual(signature, Buffer.from(record.authentication_sha256, 'hex'))) {
        throw new Error('Disposable registration authentication failed; preserve the untrusted record and payload.');
    }
    if (record.workspace_identity !== locations.workspaceIdentity || record.task_id !== locations.taskId
        || record.run_id !== runId || record.registration_id !== registrationId
        || record.payload_relative_path !== path.relative(locations.runtimeDir, paths.payloadPath).replace(/\\/gu, '/')) {
        throw new Error('Disposable registration does not match the canonical workspace, task, current native run or payload path.');
    }
    const rootBinding = bindContainedDestination(locations.root, paths.payloadPath);
    if (rootBinding.missingAt === null && (!fs.lstatSync(rootBinding.path).isDirectory()
        || scratchBindingIdentity(rootBinding) !== record.root_creation_identity)) {
        throw new Error('Disposable payload creation identity changed; preserve its replacement.');
    }
    const alive = record.hostname === os.hostname() ? isProcessLikelyAlive(record.pid) : null;
    const producerState = record.hostname !== os.hostname() ? 'foreign' : alive === false ? 'dead'
        : alive === true && record.pid === process.pid && record.producer_instance_id === PRODUCER_INSTANCE_ID
            ? 'live' : 'unknown';
    const currentOwner = readScratchFile(owner.binding, OWNER_BYTES);
    if (currentOwner.identity !== owner.identity || currentOwner.sha256 !== owner.sha256
        || readCurrentRun(locations) !== runId) throw new Error('Disposable owner or native run changed during inspection.');
    const currentAuthority = readScratchFile(authority.binding, AUTHORITY_BYTES);
    if (currentAuthority.identity !== authority.identity || currentAuthority.sha256 !== authority.sha256) {
        throw new Error('Disposable private authority changed during owner inspection.');
    }
    assertContainedDestination(rootBinding);
    return { record: Object.freeze(record), rootBinding, ownerSha256: owner.sha256, producerState,
        authorityIdentity: scratchSha256(JSON.stringify([scratchBindingIdentity(authority.binding), authority.identity, authority.sha256])),
        ownerFile: { binding: owner.binding, identity: owner.identity, sha256: owner.sha256, bytes: owner.bytes, mtimeMs: owner.mtimeMs } };
}

function inspectRegistration(locations: ProducerLocations, registrationId: string): OwnedDisposableArtifactInspection {
    const inspected = inspectRegistrationOwner(locations, registrationId);
    if (inspected.rootBinding.missingAt !== null) {
        throw new Error('Registered disposable payload root is missing or not a directory.');
    }
    return { record: inspected.record, rootBinding: inspected.rootBinding,
        ownerSha256: inspected.ownerSha256, producerState: inspected.producerState };
}

function withProducerMutation<T>(locations: ProducerLocations, callback: (checkLock: () => void) => T): T {
    return withLifecycleOperationLock(locations.root, 'disposable-producer-registration', () =>
        withScratchWriterLock(locations, checkLock =>
            withLifecycleRuntimeMutationGeneration(locations.bundleRoot, 'disposable-producer-registration', () => callback(checkLock))));
}

export function registerOwnedDisposableArtifact(options: OwnedDisposableArtifactRegistrationOptions): OwnedDisposableArtifactRegistration {
    assertInputFields(options, 'category');
    if (!OWNED_DISPOSABLE_ARTIFACT_CATEGORIES.includes(options.category)) throw new Error('Unknown disposable artifact category.');
    const locations = resolveLocations(options);
    return withProducerMutation(locations, checkLock => {
        const runId = readCurrentRun(locations), registrationId = randomUUID();
        const paths = producerPaths(locations, runId, registrationId), key = readAuthority(locations, true);
        const ownerBinding = bindContainedDestination(locations.root, paths.ownerPath);
        const payloadBinding = bindContainedDestination(locations.root, paths.payloadPath);
        if (ownerBinding.missingAt === null || payloadBinding.missingAt === null) {
            throw new Error('Disposable registration requires fresh exclusive roots; existing ownership cannot be adopted.');
        }
        checkLock();
        ensureContainedDirectory(locations.root, path.dirname(paths.payloadPath));
        ensureContainedDirectory(locations.root, path.dirname(paths.ownerPath));
        assertContainedDestination(bindContainedDestination(locations.root, paths.payloadPath));
        fs.mkdirSync(paths.payloadPath);
        const rootBinding = bindContainedDestination(locations.root, paths.payloadPath);
        const record: OwnedDisposableArtifactRecord = { schema_version: 1, kind: 'owned_disposable_artifact',
            registration_id: registrationId, workspace_identity: locations.workspaceIdentity, task_id: locations.taskId,
            run_id: runId, category: options.category,
            payload_relative_path: path.relative(locations.runtimeDir, paths.payloadPath).replace(/\\/gu, '/'),
            root_creation_identity: scratchBindingIdentity(rootBinding), pid: process.pid, hostname: os.hostname(),
            producer_instance_id: PRODUCER_INSTANCE_ID,
            registered_at_utc: new Date().toISOString(), sealed_at_utc: null, authentication_sha256: '' };
        record.authentication_sha256 = authentication(record, key).toString('hex');
        checkLock(); assertContainedDestination(rootBinding);
        if (readCurrentRun(locations) !== runId) throw new Error('Native task run changed before registration publication; preserve the orphan root.');
        assertContainedDestination(bindContainedDestination(locations.root, paths.ownerPath));
        writeContainedFile(locations.root, paths.ownerPath, JSON.stringify(record) + '\n');
        assertContainedDestination(rootBinding);
        inspectRegistration(locations, registrationId);
        return { registrationId, ...paths };
    });
}

export function inspectOwnedDisposableArtifact(options: OwnedDisposableArtifactSelection): OwnedDisposableArtifactInspection {
    assertInputFields(options, 'registrationId');
    return inspectRegistration(resolveLocations(options), options.registrationId);
}

// Owner/run authentication remains readable after retirement. Absence is not removal or recovery authority.
export function inspectOwnedDisposableArtifactOwner(options: OwnedDisposableArtifactSelection): OwnedDisposableArtifactOwnerInspection {
    assertInputFields(options, 'registrationId');
    return inspectRegistrationOwner(resolveLocations(options), options.registrationId);
}

export function sealOwnedDisposableArtifact(options: OwnedDisposableArtifactSelection): OwnedDisposableArtifactInspection {
    assertInputFields(options, 'registrationId');
    const locations = resolveLocations(options);
    return withProducerMutation(locations, checkLock => {
        const inspected = inspectRegistration(locations, options.registrationId);
        if (inspected.record.pid !== process.pid || inspected.record.hostname !== os.hostname()
            || inspected.record.producer_instance_id !== PRODUCER_INSTANCE_ID) {
            throw new Error('Only the exact original local producer may seal its disposable registration.');
        }
        if (inspected.record.sealed_at_utc) return inspected;
        const record = { ...inspected.record, sealed_at_utc: new Date().toISOString() };
        if (record.sealed_at_utc < record.registered_at_utc) {
            throw new Error('Disposable seal clock precedes registration; preserve the unsealed owner and retry after clock recovery.');
        }
        record.authentication_sha256 = authentication(record, readAuthority(locations, false)).toString('hex');
        const paths = producerPaths(locations, record.run_id, record.registration_id);
        const beforeWrite = inspectRegistration(locations, options.registrationId);
        if (beforeWrite.ownerSha256 !== inspected.ownerSha256) throw new Error('Disposable producer changed before sealing.');
        checkLock(); assertContainedDestination(inspected.rootBinding);
        writeContainedFile(locations.root, paths.ownerPath, JSON.stringify(record) + '\n');
        return inspectRegistration(locations, options.registrationId);
    });
}
