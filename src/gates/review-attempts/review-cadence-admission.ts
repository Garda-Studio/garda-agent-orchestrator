import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isPlainRecord } from '../../core/records';
import { redactSensitiveData, sha256RedactedJsonPayload } from '../../core/redaction';
import { countNextStepWork } from '../../core/next-step-measurement';
import { buildEventIntegrityHash, inspectTaskEventFile } from '../../gate-runtime/task-events';
import { assertTaskTimelineReadSnapshotCurrent,
    readTaskTimelineFileMetadataSnapshot, captureTaskTimelineReadSnapshotByteLength, assertTaskTimelineAppendPrecondition, withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { decodeClosedReviewEnvelope, encodeClosedReviewEnvelope, resolveClosedReviewAuthentication,
    type ClosedReviewAuthentication } from './review-closed-cycle-auth';

const FAILURE = /^(?:(?:CODE|DB|SECURITY|REFACTOR|API|TEST|PERFORMANCE|INFRA|DEPENDENCY) REVIEW|REVIEW) FAILED$/u;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The existing cadence rule; JSON findings/guard FAIL is deliberately not an input. */
export function reviewCadenceFailedFromDetails(details: Record<string, unknown>): boolean {
    const verdict = String(details.verdict_token || details.status || '').trim().toUpperCase();
    if (FAILURE.test(verdict)) return true;
    const artifactPath = String(details.review_artifact_snapshot_path || '').trim();
    if (!artifactPath || !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) return false;
    const bytes = fs.readFileSync(artifactPath);
    if (typeof details.review_artifact_snapshot_sha256 === 'string'
        && sha256(bytes) !== details.review_artifact_snapshot_sha256) {
        throw new Error('Cadence admission snapshot changed after owning-gate validation.');
    }
    const match = bytes.toString('utf8').match(/(?:^|\n)## Verdict\s*\r?\n\s*([^\r\n]+)/iu);
    return FAILURE.test(String(match?.[1] || '').trim().toUpperCase());
}

function unsignedDetails(details: Record<string, unknown>): Record<string, unknown> {
    const result = { ...details };
    delete result.cadence_admission;
    return result;
}
function factDigest(taskId: string, details: Record<string, unknown>): string {
    return sha256RedactedJsonPayload({ schema_version: 2, event_source: 'task-events', task_id: taskId,
        event_type: 'REVIEW_RECORDED', actor: 'gate', outcome: 'PASS', details: unsignedDetails(details) });
}
function admissionHeader(event: Readonly<Record<string, unknown>>, taskId: string): boolean {
    return event.schema_version === 2 && event.event_source === 'task-events' && event.task_id === taskId
        && event.event_type === 'REVIEW_RECORDED' && event.actor === 'gate' && event.outcome === 'PASS';
}

/** Call only at the two owning record transactions, after their existing evidence assertions. */
export function admitNativeReviewCadence(repoRoot: string, taskId: string, input: Record<string, unknown>): Record<string, unknown> {
    return sealReviewCadenceAdmission(resolveClosedReviewAuthentication(repoRoot, true), taskId, input);
}
export function sealReviewCadenceAdmission(auth: ClosedReviewAuthentication, taskId: string, input: Record<string, unknown>): Record<string, unknown> {
    const details = { ...input };
    delete details.cadence_admission;
    delete details.cadence_failed;
    delete details.cadence_schema_version;
    const redacted = redactSensitiveData(details) as Record<string, unknown>;
    const failed = reviewCadenceFailedFromDetails(redacted);
    const durable = { ...redacted, cadence_schema_version: 1, cadence_failed: failed };
    const admission = encodeClosedReviewEnvelope(auth, 'cadence', {
        schema_version: 1, purpose: 'record', task_id: taskId, fact_sha256: factDigest(taskId, durable), cadence_failed: failed
    });
    return { ...durable, cadence_admission: admission.toString('base64') };
}

/** Producer/bootstrap check. Missing legacy evidence is unknown; malformed/forged present evidence throws. */
export function validateReviewCadenceAdmission(auth: ClosedReviewAuthentication, taskId: string,
    event: Readonly<Record<string, unknown>>): boolean | null {
    const details = isPlainRecord(event.details) ? event.details : {};
    if (details.cadence_admission === undefined && details.cadence_failed === undefined
        && details.cadence_schema_version === undefined) return null;
    if (!admissionHeader(event, taskId) || details.cadence_schema_version !== 1
        || typeof details.cadence_failed !== 'boolean' || typeof details.cadence_admission !== 'string')
        throw new Error('Invalid cadence record admission.');
    countNextStepWork('cadence_record_hmac_verify');
    const proof = decodeClosedReviewEnvelope(auth, 'cadence', Buffer.from(details.cadence_admission, 'base64'));
    if (!isPlainRecord(proof) || proof.schema_version !== 1 || proof.purpose !== 'record'
        || proof.task_id !== taskId || proof.fact_sha256 !== factDigest(taskId, details)
        || proof.cadence_failed !== details.cadence_failed) throw new Error('Cadence admission fact mismatch.');
    return details.cadence_failed;
}

interface CadenceHead {
    schema_version: 1; purpose: 'head'; task_id: string; timeline_sha256: string; timeline_bytes: number;
    last_event_sha256: string | null; last_sequence: number;
}
const verifiedHead = Symbol('verified-cadence-head');
export interface VerifiedCadenceHead extends CadenceHead { readonly [verifiedHead]: true }

/** One constant-sized HMAC check in navigation; exact byte SHA is already captured by the timeline owner. */
export function verifyCadenceHead(auth: ClosedReviewAuthentication, taskId: string, timelineSha256: string,
    timelineBytes: number, certificate: Buffer): VerifiedCadenceHead {
    countNextStepWork('cadence_head_hmac_verify');
    const value = decodeClosedReviewEnvelope(auth, 'cadence', certificate);
    if (!isPlainRecord(value) || value.schema_version !== 1 || value.purpose !== 'head'
        || value.task_id !== taskId || value.timeline_sha256 !== timelineSha256
        || typeof value.timeline_bytes !== 'string' || !/^[0-9]{16}$/u.test(value.timeline_bytes)
        || Number(value.timeline_bytes) !== timelineBytes
        || (value.last_event_sha256 !== null && !/^[a-f0-9]{64}$/u.test(String(value.last_event_sha256)))
        || typeof value.last_sequence !== 'string' || !/^[0-9]{16}$/u.test(value.last_sequence)
        || !Number.isSafeInteger(Number(value.last_sequence)))
        throw new Error('Cadence head does not cover the current verified timeline.');
    return Object.freeze({ ...value, timeline_bytes: Number(value.timeline_bytes),
        last_sequence: Number(value.last_sequence), [verifiedHead]: true }) as unknown as VerifiedCadenceHead;
}

function encodeCadenceHead(auth: ClosedReviewAuthentication, head: CadenceHead): Buffer {
    // Fixed-width counters keep certificate parse/copy work independent of timeline length.
    return encodeClosedReviewEnvelope(auth, 'cadence', { ...head,
        timeline_bytes: String(head.timeline_bytes).padStart(16, '0'),
        last_sequence: String(head.last_sequence).padStart(16, '0') });
}

/** Called in the existing mandatory verification pass after a valid exact-head certificate was acquired. */
export function readCoveredReviewCadenceFailure(head: VerifiedCadenceHead,
    event: Readonly<Record<string, unknown>>): boolean | null {
    if (head[verifiedHead] !== true || !admissionHeader(event, head.task_id)) return null;
    const details = isPlainRecord(event.details) ? event.details : {};
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    if (details.cadence_schema_version !== 1 || typeof details.cadence_failed !== 'boolean'
        || typeof details.cadence_admission !== 'string' || typeof integrity.event_sha256 !== 'string') return null;
    return details.cadence_failed;
}

/** Expensive explicit writer recovery only. Never called by navigation or from the lookup helper. */
export function bootstrapCadenceHead(auth: ClosedReviewAuthentication, taskId: string, timelinePath: string): Buffer {
    return withTaskTimelineFileReadSnapshot(timelinePath, () => {
        let lastEventSha256: string | null = null;
        const inspection = inspectTaskEventFile(timelinePath, taskId, { onIntegrityEvent: event => {
            countNextStepWork('visit:cadence_bootstrap_event');
            if (event.event_type === 'REVIEW_RECORDED') validateReviewCadenceAdmission(auth, taskId, event);
            const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
            lastEventSha256 = String(integrity.event_sha256 || '');
        } });
        if (!['MISSING', 'EMPTY', 'LEGACY_ONLY', 'PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status))
            throw new Error('Cadence bootstrap requires a fully verified timeline.');
        const snapshot = readTaskTimelineFileMetadataSnapshot(timelinePath);
        if (!snapshot.valid) throw new Error('Cadence bootstrap snapshot is unavailable.');
        const snapshotSha = snapshot.sha256 || sha256(Buffer.alloc(0));
        const byteLength = captureTaskTimelineReadSnapshotByteLength(timelinePath);
        if (snapshot.exists) assertTaskTimelineReadSnapshotCurrent(timelinePath, snapshotSha);
        else assertTaskTimelineAppendPrecondition(timelinePath);
        return encodeCadenceHead(auth, {
            schema_version: 1, purpose: 'head', task_id: taskId, timeline_sha256: snapshotSha,
            timeline_bytes: byteLength, last_event_sha256: lastEventSha256,
            last_sequence: inspection.last_integrity_sequence ?? inspection.matching_events
        } satisfies CadenceHead);
    });
}

/** Only the canonical append owner may call this with its authenticated exact post-write transition. */
export function advanceCadenceHead(auth: ClosedReviewAuthentication, taskId: string, certificate: Buffer,
    transition: { beforeSha256: string; beforeBytes: number; afterSha256: string; afterBytes: number;
        appendedEvent: Readonly<Record<string, unknown>> }): Buffer {
    const previous = verifyCadenceHead(auth, taskId, transition.beforeSha256, transition.beforeBytes, certificate);
    const event = transition.appendedEvent;
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    if (event.task_id !== taskId || integrity.prev_event_sha256 !== previous.last_event_sha256
        || integrity.task_sequence !== previous.last_sequence + 1 || buildEventIntegrityHash(event) !== integrity.event_sha256
        || !/^[a-f0-9]{64}$/u.test(transition.afterSha256)
        || !Number.isSafeInteger(transition.afterBytes) || transition.afterBytes <= transition.beforeBytes)
        throw new Error('Cadence head transition is not the native authenticated append.');
    if (event.event_type === 'REVIEW_RECORDED') validateReviewCadenceAdmission(auth, taskId, event);
    return encodeCadenceHead(auth, {
        schema_version: 1, purpose: 'head', task_id: taskId, timeline_sha256: transition.afterSha256,
        timeline_bytes: transition.afterBytes, last_event_sha256: String(integrity.event_sha256),
        last_sequence: Number(integrity.task_sequence)
    } satisfies CadenceHead);
}
