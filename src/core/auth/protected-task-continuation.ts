import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertExistingPathIdentity, bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../contained-filesystem';
import { readTransactionBytes } from '../file-transaction-journal';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation } from '../operator-confirmation';
import { assertValidTaskId, readTaskTimelineJsonlEntries } from '../../gate-runtime/timeline/task-events-helpers';
import { joinOrchestratorPath } from '../orchestrator-paths';
import { isPlainRecord } from '../records';
import { withFilesystemLock } from '../../gate-runtime/timeline/task-events-locking';

interface ContinuationContext {
    root: string;
    gitRoot: string;
    storage: string;
    identity: string;
}

export interface ProtectedTaskContinuation {
    domain: string;
    workspace_identity: string;
    task_id: string;
    artifact_sha256: string;
    entry_sha256: string;
    config_sha256: string;
    operator_confirmed_at_utc: string;
    hmac_sha256: string;
}

const DOMAIN = 'garda.protected-task-continuation.v1';
const SHA = /^[a-f0-9]{64}$/u;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const verified = new WeakMap<object, { root: string; scope: string }>();

interface ProtectedRequest {
    repoRoot: string; taskId: string; taskSummary: string; provider: string; routedTo: string;
    plannedChangedFiles: string[]; orchestratorWork: boolean; workflowConfigWork: boolean;
}

function requestDigest(request: Omit<ProtectedRequest, 'repoRoot'>): string {
    return digest(JSON.stringify([request.taskId, request.taskSummary, request.provider, request.routedTo,
        request.orchestratorWork, request.workflowConfigWork, [...request.plannedChangedFiles].sort()]));
}

export function isVerifiedProtectedTaskContinuation(value: unknown, request: ProtectedRequest): boolean {
    if (!value || typeof value !== 'object') return false;
    const proof = verified.get(value);
    return !!proof && proof.root === fs.realpathSync.native(path.resolve(request.repoRoot))
        && proof.scope === requestDigest(request);
}

function context(repoRoot: string): ContinuationContext {
    const root = fs.realpathSync.native(path.resolve(repoRoot));
    const rootBinding = bindContainedDestination(root, root);
    const gitPath = path.join(root, '.git');
    bindContainedDestination(root, gitPath);
    const stat = fs.lstatSync(gitPath);
    const pointer = stat.isFile() ? readTransactionBytes(root, gitPath, 4096)?.toString().trim().match(/^gitdir:\s*(.+)$/u) : null;
    const git = stat.isDirectory() ? gitPath : pointer ? path.resolve(root, pointer[1]) : '';
    if (!git || !fs.lstatSync(git).isDirectory()) throw new Error('Protected continuation requires native Git metadata.');
    const gitRoot = fs.realpathSync.native(git);
    const gitBinding = bindContainedDestination(gitRoot, git);
    const canonical = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;
    const identity = digest(JSON.stringify([canonical(root), canonical(gitRoot),
        ...[rootBinding.existing[0], gitBinding.existing[0]].map(i => [String(i.dev), String(i.ino), String(i.birthtimeNs)])]));
    assertExistingPathIdentity(rootBinding);
    assertExistingPathIdentity(gitBinding);
    return { root, gitRoot, identity, storage: path.join(gitRoot, 'garda-private/protected-task-entry') };
}

function key(ctx: ContinuationContext, taskId: string): Buffer | null {
    const file = path.join(ctx.storage, `${taskId}.key`);
    const bytes = readTransactionBytes(ctx.gitRoot, file, 128);
    if (!bytes) return null;
    const value = bytes.toString().trim();
    if (!SHA.test(value)) throw new Error('Protected continuation key is invalid.');
    return Buffer.from(value, 'hex');
}

function signature(record: Omit<ProtectedTaskContinuation, 'hmac_sha256'>, secret: Buffer): Buffer {
    return createHmac('sha256', secret).update(JSON.stringify(record)).digest();
}

function authenticated(record: ProtectedTaskContinuation, ctx: ContinuationContext, secret: Buffer): boolean {
    const { hmac_sha256, ...unsigned } = record;
    return record.domain === DOMAIN && record.workspace_identity === ctx.identity && SHA.test(String(hmac_sha256))
        && timingSafeEqual(signature(unsigned, secret), Buffer.from(hmac_sha256, 'hex'));
}

export function endsProtectedTaskContinuation(eventType: string, details: unknown): boolean {
    return ['TASK_DONE', 'TASK_RESET', 'TASK_DISCARDED'].includes(eventType)
        || (eventType === 'STATUS_CHANGED' && isPlainRecord(details)
            && !['IN_PROGRESS', 'IN_REVIEW'].includes(String(details.new_status)));
}

export function revokeProtectedTaskContinuationForEvent(
    orchestratorRoot: string, eventsRoot: string, taskId: string, eventType: string, details: unknown
): void {
    if (!endsProtectedTaskContinuation(eventType, details)) return;
    assertValidTaskId(taskId);
    const canonical = (file: string): string => process.platform === 'win32'
        ? path.resolve(file).toLowerCase() : path.resolve(file);
    let candidate = path.resolve(orchestratorRoot);
    for (let depth = 0; depth < 20; depth += 1) {
        let gitExists = false;
        try { fs.lstatSync(path.join(candidate, '.git')); gitExists = true; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (gitExists) {
            // Custom event stores cannot revoke a grant for the authoritative native timeline.
            if (canonical(joinOrchestratorPath(candidate, 'runtime/task-events')) !== canonical(eventsRoot)) return;
            const ctx = context(candidate);
            if (!key(ctx, taskId)) return;
            const keyPath = path.join(ctx.storage, `${taskId}.key`);
            writeContainedFile(ctx.gitRoot, keyPath, randomBytes(32).toString('hex') + '\n');
            fs.chmodSync(keyPath, 0o600);
            return;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) return;
        candidate = parent;
    }
}

function currentEntryHash(repoRoot: string, taskId: string): string | null {
    const file = joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`);
    const records = readTaskTimelineJsonlEntries(file).map(entry => entry.record);
    let index = records.length - 1;
    while (index >= 0 && records[index]?.event_type !== 'TASK_MODE_ENTERED') index -= 1;
    if (index < 0 || records.some(record => !record)) return null;
    const ended = records.slice(index + 1).some(record =>
        record && endsProtectedTaskContinuation(String(record.event_type), record.details));
    return ended ? null : digest(JSON.stringify(records[index]));
}

function configHash(hashes: Record<string, string | null>): string {
    return digest(JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))));
}

export function resolveProtectedTaskContinuation(input: {
    repoRoot: string; taskId: string; artifactPath: string; currentConfigHashes: Record<string, string | null>;
}): ProtectedTaskContinuation | null {
    assertValidTaskId(input.taskId);
    const ctx = context(input.repoRoot);
    const bytes = readTransactionBytes(ctx.gitRoot, path.join(ctx.storage, `${input.taskId}.json`), 32768);
    const secret = key(ctx, input.taskId);
    if (!bytes || !secret) return null;
    let record: ProtectedTaskContinuation;
    try { record = JSON.parse(bytes.toString()); } catch { return null; }
    if (!record || typeof record !== 'object' || !authenticated(record, ctx, secret) || record.task_id !== input.taskId) return null;
    const artifact = readTransactionBytes(ctx.root, path.resolve(input.artifactPath), 1024 * 1024);
    if (!artifact || record.artifact_sha256 !== digest(artifact)
        || record.entry_sha256 !== currentEntryHash(ctx.root, input.taskId)
        || record.config_sha256 !== configHash(input.currentConfigHashes)) return null;
    const mode = JSON.parse(artifact.toString());
    if (!isPlainRecord(mode) || mode.task_id !== input.taskId || !Array.isArray(mode.planned_changed_files)) return null;
    Object.freeze(record);
    verified.set(record, { root: ctx.root, scope: requestDigest({ taskId: input.taskId,
        taskSummary: String(mode.task_summary || ''), provider: String(mode.provider || ''), routedTo: String(mode.routed_to || ''),
        plannedChangedFiles: mode.planned_changed_files.map(String), orchestratorWork: mode.orchestrator_work === true,
        workflowConfigWork: mode.workflow_config_work === true }) });
    return record;
}

export function publishProtectedTaskContinuation(input: {
    repoRoot: string; taskId: string; artifactPath: string; currentConfigHashes: Record<string, string | null>;
    expectedArtifact: unknown;
    operatorConfirmed?: unknown; operatorConfirmedAtUtc?: unknown; previous?: ProtectedTaskContinuation | null;
}): void {
    assertValidTaskId(input.taskId);
    const ctx = context(input.repoRoot);
    const eventsRoot = joinOrchestratorPath(ctx.root, 'runtime/task-events');
    ensureContainedDirectory(ctx.root, eventsRoot);
    const eventBinding = bindContainedDestination(ctx.root, eventsRoot);
    const lockPath = path.join(eventsRoot, `.${input.taskId}.lock`);
    bindContainedDestination(ctx.root, lockPath);
    withFilesystemLock(lockPath, { requireKnownDeadOwner: true }, () => {
        assertExistingPathIdentity(eventBinding);
        if (!input.previous) validateFreshOperatorConfirmation({ actionLabel: 'Protected task continuation admission',
            confirmed: parseOperatorConfirmationYes(input.operatorConfirmed), confirmedAtUtc: String(input.operatorConfirmedAtUtc || ''),
            requireConfirmedAtUtc: true, instruction: 'Initial protected entry requires genuine operator approval.' });
        const previousSecret = key(ctx, input.taskId);
        if (input.previous && (!previousSecret || !authenticated(input.previous, ctx, previousSecret))) {
            throw new Error('Protected continuation authority was revoked.');
        }
        const bytes = readTransactionBytes(ctx.root, path.resolve(input.artifactPath), 1024 * 1024);
        const entry = currentEntryHash(ctx.root, input.taskId);
        if (!bytes || !entry || JSON.stringify(JSON.parse(bytes.toString())) !== JSON.stringify(input.expectedArtifact)) {
            throw new Error('Protected continuation requires unchanged authoritative native entry evidence.');
        }
        const record: Omit<ProtectedTaskContinuation, 'hmac_sha256'> = { domain: DOMAIN, workspace_identity: ctx.identity,
            task_id: input.taskId, artifact_sha256: digest(bytes), entry_sha256: entry,
            config_sha256: configHash(input.currentConfigHashes),
            operator_confirmed_at_utc: input.previous?.operator_confirmed_at_utc ?? String(input.operatorConfirmedAtUtc) };
        ensureContainedDirectory(ctx.gitRoot, ctx.storage);
        // Rotate before publishing: interrupted admission leaves older grants revoked.
        const secret = randomBytes(32);
        const keyPath = path.join(ctx.storage, `${input.taskId}.key`);
        writeContainedFile(ctx.gitRoot, keyPath, secret.toString('hex') + '\n');
        fs.chmodSync(keyPath, 0o600);
        const target = path.join(ctx.storage, `${input.taskId}.json`);
        writeContainedFile(ctx.gitRoot, target, JSON.stringify({ ...record, hmac_sha256: signature(record, secret).toString('hex') }) + '\n');
        fs.chmodSync(target, 0o600);
    });
}
