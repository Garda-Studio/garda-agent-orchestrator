import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isPlainRecord } from '../../core/records';
import { runGit } from '../../core/git-helpers';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { withTaskPlanMutationLock } from '../../core/task-plan-save';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../gate-runtime/task-events-locking';
import { appendMandatoryTaskEvent, assertValidTaskId, inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { withRuntimeMutationGeneration } from '../../gate-runtime/runtime-mutation-generation';
import { withReviewArtifactTransactionLock } from '../../gate-runtime/review/review-artifacts';
import { readParentAuditProofBytes, readParentAuditProofRecord } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import type { ParentRecord } from './parent-audit-types';

export function parentDigest(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function parentAuthenticationContext(root: string, create: boolean) {
    const canonicalRoot = fs.realpathSync.native(root), git = path.join(canonicalRoot, '.git');
    const gitStat = fs.lstatSync(git);
    if (gitStat.isSymbolicLink()) throw new Error('Parent authentication rejects symbolic Git metadata.');
    const pointer = gitStat.isFile() ? fs.readFileSync(git, 'utf8').trim().match(/^gitdir:\s*(.+)$/u) : null;
    const directory = gitStat.isDirectory() ? git : pointer ? path.resolve(canonicalRoot, pointer[1]) : '';
    if (!directory) throw new Error('Parent authentication requires a Git workspace.');
    const gitDirectory = fs.realpathSync.native(directory), keyPath = path.join(gitDirectory, 'garda-private/parent-audit-key');
    bindContainedDestination(gitDirectory, keyPath);
    if (create && !fs.existsSync(keyPath)) {
        if (Object.keys(process.env).some(name => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_CONFIG(?:_|$))/iu.test(name))) {
            throw new Error('Parent key creation rejects Git environment overrides.');
        }
        const options = { timeoutMs: 10000, maxBuffer: 65536 };
        if (fs.realpathSync.native(runGit(canonicalRoot, ['rev-parse', '--show-toplevel'], options).trim()) !== canonicalRoot
            || fs.realpathSync.native(runGit(canonicalRoot, ['rev-parse', '--absolute-git-dir'], options).trim()) !== gitDirectory) {
            throw new Error('Parent key destination is not this native Git workspace.');
        }
        ensureContainedDirectory(gitDirectory, path.dirname(keyPath));
        const { handle } = acquireFilesystemLock(keyPath + '.lock', { ownerLabel: 'parent-audit-key', requireKnownDeadOwner: true });
        try {
            if (!fs.existsSync(keyPath)) {
                writeContainedFile(gitDirectory, keyPath, randomBytes(32).toString('hex') + '\n');
                fs.chmodSync(keyPath, 0o600);
            }
        } finally { releaseFilesystemLock(handle); }
    }
    if (!fs.existsSync(keyPath)) throw new Error('Parent authentication key is missing.');
    bindContainedDestination(gitDirectory, keyPath);
    const key = readParentAuditProofBytes(gitDirectory, keyPath).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('Parent authentication key is invalid.');
    const identity = fs.statSync(canonicalRoot, { bigint: true });
    const normalize = (value: string) => process.platform === 'win32' ? value.replace(/\\/gu, '/').toLowerCase() : value;
    return { key: Buffer.from(key, 'hex'), workspace: parentDigest(JSON.stringify([normalize(canonicalRoot), normalize(gitDirectory),
        String(identity.dev), String(identity.ino), String(identity.birthtimeNs)])) };
}

function parentAuthentication(root: string, record: ParentRecord, create: boolean) {
    const context = parentAuthenticationContext(root, create), unsigned = { ...record };
    delete unsigned.parent_audit_authentication;
    return { workspace_sha256: context.workspace, hmac_sha256: createHmac('sha256', context.key)
        .update(JSON.stringify({ domain: 'garda.parent-audit.v1', workspace: context.workspace, record: unsigned })).digest('hex') };
}

export function parentArtifactPath(root: string, taskId: string, kind: string): string {
    assertValidTaskId(taskId);
    if (!/^[a-z][a-z0-9-]*$/u.test(kind)) throw new Error('Invalid parent-audit artifact kind.');
    return joinOrchestratorPath(root, `runtime/reviews/${taskId}-parent-${kind}.json`);
}

export function readParentEvents(root: string, taskId: string): Record<string, unknown>[] {
    const file = joinOrchestratorPath(root, `runtime/task-events/${assertValidTaskId(taskId)}.jsonl`);
    const integrity = inspectTaskEventFile(file, taskId);
    if (integrity.status === 'MISSING' || integrity.status === 'EMPTY') return [];
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(integrity.status) || integrity.violations.length) {
        throw new Error('Parent timeline integrity is not accepted: ' + integrity.status);
    }
    return readTaskTimelineJsonlEntries(file).map(entry => entry.record).filter(isPlainRecord);
}

function assertAuthentication(root: string, record: ParentRecord): void {
    const expected = parentAuthentication(root, record, false);
    const actual = record.parent_audit_authentication;
    if (!isPlainRecord(expected) || !isPlainRecord(actual)
        || expected.workspace_sha256 !== actual.workspace_sha256
        || typeof actual.hmac_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(actual.hmac_sha256)
        || !timingSafeEqual(Buffer.from(String(expected.hmac_sha256), 'hex'), Buffer.from(actual.hmac_sha256, 'hex'))) {
        throw new Error('Parent evidence is unauthenticated or belongs to another workspace.');
    }
}

export function readParentRecord<T extends ParentRecord>(root: string, taskId: string, kind: string): T | null {
    const file = parentArtifactPath(root, taskId, kind);
    const timeline = joinOrchestratorPath(root, `runtime/task-events/${taskId}.jsonl`);
    const hasPublication = fs.existsSync(timeline) && readTaskTimelineJsonlEntries(timeline).some(entry =>
        isPlainRecord(entry.record) && entry.record.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
        && isPlainRecord(entry.record.details) && entry.record.details.kind === kind);
    if (!fs.existsSync(file) && !hasPublication) return null;
    const events = readParentEvents(root, taskId);
    const event = [...events].reverse().find(item => item.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
        && isPlainRecord(item.details) && item.details.kind === kind);
    if (!event) {
        if (fs.existsSync(file)) throw new Error('Parent artifact has no native publication event: ' + kind);
        return null;
    }
    const details = event.details;
    if (event.outcome !== 'PASS' || !isPlainRecord(details) || typeof details.artifact_sha256 !== 'string'
        || details.artifact_path !== file.replace(/\.json$/u, '-' + details.artifact_sha256 + '.json')) throw new Error('Invalid parent publication binding.');
    const record = readParentAuditProofRecord(root, String(details.artifact_path), details.artifact_sha256) as ParentRecord;
    if (record.schema_version !== 1 || record.event_source !== 'parent-audit' || record.task_id !== taskId || record.kind !== kind) {
        throw new Error('Parent evidence identity differs.');
    }
    assertAuthentication(root, record);
    const published = events.indexOf(event);
    if (events.slice(published + 1).some(item => ['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED'].includes(String(item.event_type)))) {
        throw new Error('Parent evidence belongs to an earlier task cycle.');
    }
    return record as T;
}

export function publishParentRecord<T extends ParentRecord>(root: string, record: T): T {
    const signed = { ...record, parent_audit_authentication: parentAuthentication(root, record, true) };
    assertAuthentication(root, signed);
    const file = parentArtifactPath(root, record.task_id, record.kind);
    ensureContainedDirectory(root, path.dirname(file));
    const bytes = JSON.stringify(signed, null, 2) + '\n';
    const hash = parentDigest(bytes), version = file.replace(/\.json$/u, '-' + hash + '.json');
    if (!fs.existsSync(version)) writeParentAuditArtifact(root, version, bytes);
    readParentAuditProofRecord(root, version, hash);
    appendMandatoryTaskEvent(joinOrchestratorPath(root, ''), record.task_id, 'PARENT_AUDIT_RECORD_PUBLISHED', 'PASS',
        'Native parent audit evidence published.', { kind: record.kind, artifact_path: version, artifact_sha256: hash },
        { actor: 'orchestrator' });
    writeParentAuditArtifact(root, file, bytes);
    return signed;
}

export function writeParentAuditArtifact(root: string, file: string, bytes: string | Buffer): void {
    const reviews = joinOrchestratorPath(root, 'runtime/reviews');
    ensureContainedDirectory(root, reviews);
    bindContainedDestination(reviews, file);
    ensureContainedDirectory(root, path.dirname(file));
    withReviewArtifactTransactionLock(reviews, () =>
        withRuntimeMutationGeneration(joinOrchestratorPath(root, ''), 'parent-audit-artifact-write', () => writeContainedFile(root, file, bytes)));
}

export function withParentAuditMutation<T>(root: string, taskId: string, action: () => T): T {
    return withTaskPlanMutationLock(root, taskId, action);
}

export function parentRecordDigest(record: ParentRecord): string {
    return parentDigest(JSON.stringify(record, null, 2) + '\n');
}

export function parentRecordVersionPath(root: string, record: ParentRecord): string {
    return parentArtifactPath(root, record.task_id, record.kind).replace(/\.json$/u, '-' + parentRecordDigest(record) + '.json');
}

export function readParentRecordHistory<T extends ParentRecord>(root: string, taskId: string, kind: string): T[] {
    const canonical = parentArtifactPath(root, taskId, kind);
    return readParentEvents(root, taskId).filter(event => event.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
        && isPlainRecord(event.details) && event.details.kind === kind).map(event => {
        const details = event.details as Record<string, unknown>;
        if (event.outcome !== 'PASS' || typeof details.artifact_sha256 !== 'string'
            || details.artifact_path !== canonical.replace(/\.json$/u, '-' + details.artifact_sha256 + '.json')) {
            throw new Error('Invalid historical parent publication.');
        }
        const record = readParentAuditProofRecord(root, String(details.artifact_path), details.artifact_sha256) as ParentRecord;
        if (record.schema_version !== 1 || record.task_id !== taskId || record.event_source !== 'parent-audit' || record.kind !== kind) {
            throw new Error('Historical parent record identity differs.');
        }
        assertAuthentication(root, record);
        return record as T;
    });
}
