import { outsideInvocationReadObservation, registerInvocationDependency } from '../../core/invocation-read-observation';
import { isCapturedQualityBinding, type CapturedQualityBinding } from './persisted-quality-operation';
import { isPublishableObservationCapture, readSealedObservationPlan, type ObservationCapture } from '../../core/derivation-observation-recorder';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { bindContainedDestination, assertContainedDestination, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../gate-runtime/task-events-locking';
import { resolveClosedReviewAuthentication, type ClosedReviewAuthentication } from '../review-attempts/review-closed-cycle-auth';
import { countNextStepWork } from '../../core/next-step-measurement';
import { derivationHash, isDerivationHash, encodeDerivationValue } from '../../core/persisted-derivation-value';
import { serializableDependency, encodePersistentDependencies, type PersistentDependency } from './persisted-derivation-adapters';
export const PERSISTED_DERIVATION_SCHEMA = 1;
export const PERSISTED_DERIVATION_MAX_BYTES = 4 * 1024 * 1024;
export interface PersistentDerivationIdentity {
    schema: 1; operation: 'quality-artifact-json' | 'quality-analysis'; operationVersion: 1;
    taskId: string; lane: 'quality'; contract: 'artifact-json' | 'strict' | 'soft'; inspection: 'active' | 'retained_completed';
    workspaceSha256: string; repoRealpath: string; gitDirectoryRealpath: string;
    cycleSha256: string; querySha256: string; codeSha256: string; policySha256: string; parametersSha256: string; planSha256: string;
}
export interface PersistentDerivationRecord { identity: PersistentDerivationIdentity; dependencies: PersistentDependency[]; result: string }
interface Envelope { schema: 1; workspaceSha256: string; iv: string; ciphertext: string; tag: string; hmac: string }
const DOMAIN = 'garda.persisted-quality-leaves.v1';
function authentication(auth: ClosedReviewAuthentication, data: unknown): string {
    return createHmac('sha256', auth.key).update(JSON.stringify([DOMAIN, auth.workspaceSha256, data])).digest('hex');
}
function encryptionKey(auth: ClosedReviewAuthentication): Buffer {
    return createHmac('sha256', auth.key).update(DOMAIN + ':confidential-result').digest();
}
export function persistentDerivationPath(auth: ClosedReviewAuthentication, identity: Pick<PersistentDerivationIdentity,
    'taskId' | 'lane' | 'operation' | 'contract' | 'inspection'>): string {
    const name = derivationHash(JSON.stringify([identity.taskId, identity.lane, identity.operation, identity.contract, identity.inspection]));
    return path.join(auth.gitDirectoryRealpath, 'garda-private', 'derived-quality-v1', name + '.json');
}
function countedParse(text: string): unknown {
    countNextStepWork('q4_record_parse_bytes', Buffer.byteLength(text));
    return JSON.parse(text, (_key, value: unknown) => { countNextStepWork('visit:q4_record_value'); return value; }) as unknown;
}
export function encodePersistentDerivation(auth: ClosedReviewAuthentication, record: PersistentDerivationRecord): Buffer {
    const plaintext = Buffer.from(JSON.stringify(record));
    if (plaintext.length > PERSISTED_DERIVATION_MAX_BYTES / 2) throw new Error('Derivation exceeds persistent budget.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(auth), iv);
    cipher.setAAD(Buffer.from(DOMAIN + ':' + auth.workspaceSha256));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
    const body = { schema: 1 as const, workspaceSha256: auth.workspaceSha256, iv: iv.toString('hex'),
        ciphertext, tag: cipher.getAuthTag().toString('hex') };
    return Buffer.from(JSON.stringify({ ...body, hmac: authentication(auth, body) } satisfies Envelope) + '\n');
}
export function decodePersistentDerivation(auth: ClosedReviewAuthentication, bytes: Buffer): PersistentDerivationRecord | null {
    try {
        if (bytes.length > PERSISTED_DERIVATION_MAX_BYTES) return null;
        const value = countedParse(bytes.toString('utf8')) as Envelope;
        if (!value || value.schema !== 1 || value.workspaceSha256 !== auth.workspaceSha256
            || typeof value.iv !== 'string' || !/^[a-f0-9]{24}$/u.test(value.iv)
            || typeof value.tag !== 'string' || !/^[a-f0-9]{32}$/u.test(value.tag)
            || typeof value.ciphertext !== 'string' || !isDerivationHash(value.hmac)) return null;
        const body = { schema: 1 as const, workspaceSha256: value.workspaceSha256, iv: value.iv,
            ciphertext: value.ciphertext, tag: value.tag };
        if (!timingSafeEqual(Buffer.from(value.hmac, 'hex'), Buffer.from(authentication(auth, body), 'hex'))) return null;
        const encrypted = Buffer.from(value.ciphertext, 'base64');
        if (encrypted.toString('base64') !== value.ciphertext) return null;
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey(auth), Buffer.from(value.iv, 'hex'));
        decipher.setAAD(Buffer.from(DOMAIN + ':' + auth.workspaceSha256)); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
        const record = countedParse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')) as PersistentDerivationRecord;
        if (!record || !record.identity || !Array.isArray(record.dependencies) || record.dependencies.length > 20000
            || typeof record.result !== 'string') return null;
        for (const dependency of record.dependencies) {
            countNextStepWork('visit:q4_record_dependency'); if (!serializableDependency(dependency)) return null;
        }
        return record;
    } catch { return null; }
}
export interface PersistentCandidate { readonly bytes: Buffer | null; readonly sha256: string | null; select(): void }
/** Untrusted candidate reads do not enter Q2/A1. The selected receipt retains exact native path/bytes. */
export function readPersistentCandidate(auth: ClosedReviewAuthentication, file: string): PersistentCandidate | null {
    try {
        const binding = outsideInvocationReadObservation(() => bindContainedDestination(auth.gitDirectoryRealpath, file));
        const bytes = outsideInvocationReadObservation(() => readTransactionBytes(auth.gitDirectoryRealpath, file, PERSISTED_DERIVATION_MAX_BYTES));
        outsideInvocationReadObservation(() => assertContainedDestination(binding));
        const sha256 = bytes === null ? null : derivationHash(bytes), owner = Object.freeze({ file, sha256 });
        return { bytes, sha256, select() {
            registerInvocationDependency(owner, () => outsideInvocationReadObservation(() => {
                assertContainedDestination(binding);
                const current = readTransactionBytes(auth.gitDirectoryRealpath, file, PERSISTED_DERIVATION_MAX_BYTES);
                if ((current === null ? null : derivationHash(current)) !== sha256)
                    throw new Error('Invocation persistent derivation record changed: ' + file);
            }));
        } };
    } catch { return null; }
}
/** Native post-A1 storage effect. A conflict leaves acceleration unavailable. */
export function publishPersistentDerivation(repoRoot: string, binding: CapturedQualityBinding,
    captured: ObservationCapture<unknown>, expectedTargetSha256: string | null = null): boolean {
    let handle: ReturnType<typeof acquireFilesystemLock>['handle'] | undefined;
    try {
        if (!isCapturedQualityBinding(binding) || !isPublishableObservationCapture(captured) || !captured.outcome.returned) return false;
        const plan = readSealedObservationPlan(captured);
        if (!plan || plan.operation !== binding.identity.operation
            || derivationHash(encodeDerivationValue(plan)) !== binding.identity.planSha256) return false;
        const leaves = encodePersistentDependencies(captured.trace);
        if (!leaves) return false;
        const expectedAuth = binding.auth;
        const record: PersistentDerivationRecord = { identity: binding.identity,
            dependencies: [...binding.dependencies, ...leaves], result: encodeDerivationValue(captured.outcome.value) };
        const auth = resolveClosedReviewAuthentication(repoRoot, false);
        if (auth.workspaceSha256 !== expectedAuth.workspaceSha256 || !auth.key.equals(expectedAuth.key)) return false;
        const file = persistentDerivationPath(auth, record.identity);
        ensureContainedDirectory(auth.gitDirectoryRealpath, path.dirname(file));
        const initial = readTransactionBytes(auth.gitDirectoryRealpath, file, PERSISTED_DERIVATION_MAX_BYTES);
        const before = initial === null ? null : derivationHash(initial);
        if (before !== expectedTargetSha256) return false;
        handle = acquireFilesystemLock(file + '.lock', { ownerLabel: 'quality-derived-state', requireKnownDeadOwner: true }).handle;
        const destinationBinding = bindContainedDestination(auth.gitDirectoryRealpath, file);
        const current = readTransactionBytes(auth.gitDirectoryRealpath, file, PERSISTED_DERIVATION_MAX_BYTES);
        if ((current === null ? null : derivationHash(current)) !== before) return false;
        const bytes = encodePersistentDerivation(auth, record);
        assertContainedDestination(destinationBinding);
        writeContainedFile(auth.gitDirectoryRealpath, file, bytes);
        countNextStepWork('q4_publish'); return true;
    } catch { countNextStepWork('q4_publish_unavailable'); return false; }
    finally { if (handle) { try { releaseFilesystemLock(handle); } catch { countNextStepWork('q4_publish_release_unavailable'); } } }
}
