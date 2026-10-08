import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    assertExistingPathIdentity, bindContainedDestination, ensureContainedDirectory, writeContainedFile
} from './contained-filesystem';
import { completePathFileIdentitySync, lstatFileIdentitySync } from './file-stat';
import { joinOrchestratorPath } from './orchestrator-paths';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation,
    OPERATOR_CONFIRMATION_MAX_AGE_MS } from './operator-confirmation';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { withFilesystemLock } from '../gate-runtime/task-events-locking';

export interface TaskResetAuthorityAction {
    taskId: string;
    targetStatus: 'TODO' | 'DONE';
    eventsRoot: string;
    reviewsRoot: string;
    scopeSha256: string;
}

interface AuthorityContext {
    root: string;
    gitDirectory: string;
    storageRoot: string;
    workspaceIdentity: string;
}

interface AuthorityRecord {
    schema_version: 1;
    domain: string;
    authority_id: string;
    workspace_identity: string;
    action_sha256: string;
    operator_confirmed_at_utc: string;
    issued_at_ms: number;
    expires_at_ms: number;
    consumed: boolean;
    hmac_sha256: string;
}

const DOMAIN = 'garda.task-reset.one-action.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 4096;

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(value: string): string {
    const normalized = path.resolve(value).replace(/\\/gu, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function actionDigest(root: string, action: TaskResetAuthorityAction): string {
    assertValidTaskId(action.taskId);
    if (!['TODO', 'DONE'].includes(action.targetStatus) || !SHA256_PATTERN.test(action.scopeSha256)) {
        throw new Error('Task reset one-action authority requires a concrete target and native scope digest.');
    }
    const events = bindContainedDestination(root, path.resolve(action.eventsRoot));
    const reviews = bindContainedDestination(root, path.resolve(action.reviewsRoot));
    return sha256(JSON.stringify([action.taskId, action.targetStatus,
        canonicalPath(events.path), canonicalPath(reviews.path), action.scopeSha256]));
}

function resolveContext(repoRoot: string): AuthorityContext {
    const root = fs.realpathSync.native(path.resolve(repoRoot));
    const rootBinding = bindContainedDestination(root, root);
    const gitPath = path.join(root, '.git');
    bindContainedDestination(root, gitPath);
    const gitStat = lstatFileIdentitySync(gitPath);
    const pointer = gitStat.isFile() ? readOrdinaryFile(root, gitPath).trim().match(/^gitdir:\s*(.+)$/u) : null;
    const gitDirectory = gitStat.isDirectory() ? gitPath : pointer ? path.resolve(root, pointer[1]) : '';
    if (!gitDirectory || !lstatFileIdentitySync(gitDirectory).isDirectory()) {
        throw new Error('Task reset one-action authority requires native Git workspace metadata.');
    }
    const canonicalGit = fs.realpathSync.native(gitDirectory);
    const gitBinding = bindContainedDestination(canonicalGit, gitDirectory);
    const identities = [rootBinding.existing[0], gitBinding.existing[0]];
    const workspaceIdentity = sha256(JSON.stringify([canonicalPath(root), canonicalPath(canonicalGit),
        ...identities.map((identity) => [String(identity.dev), String(identity.ino), String(identity.birthtimeNs)])]));
    assertExistingPathIdentity(rootBinding);
    assertExistingPathIdentity(gitBinding);
    return { root, gitDirectory: canonicalGit, storageRoot: path.join(canonicalGit, 'garda-private/task-reset-authority'),
        workspaceIdentity };
}

function readOrdinaryFile(root: string, filePath: string): string {
    const binding = bindContainedDestination(root, filePath);
    const before = lstatFileIdentitySync(filePath);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_RECORD_BYTES) {
        throw new Error('Task reset authority input must be a bounded ordinary unlinked file.');
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
            throw new Error('Task reset authority input identity changed before read.');
        }
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
        const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(descriptor);
        assertExistingPathIdentity(binding);
        if (length > MAX_RECORD_BYTES || length !== before.size || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new Error('Task reset authority input changed during read.');
        }
        return bytes.subarray(0, length).toString('utf8');
    } finally { fs.closeSync(descriptor); }
}

function permissionKey(context: AuthorityContext, create: boolean): Buffer {
    const keyPath = path.join(context.storageRoot, 'key');
    if (!fs.existsSync(keyPath) && create) {
        ensureContainedDirectory(context.gitDirectory, context.storageRoot);
        const lockPath = path.join(context.storageRoot, '.key.lock');
        const parent = bindContainedDestination(context.gitDirectory, context.storageRoot);
        bindContainedDestination(context.gitDirectory, lockPath);
        withFilesystemLock(lockPath, { requireKnownDeadOwner: true }, () => {
            assertExistingPathIdentity(parent);
            if (!fs.existsSync(keyPath)) {
                writeContainedFile(context.gitDirectory, keyPath, randomBytes(32).toString('hex'));
                fs.chmodSync(keyPath, 0o600);
            }
        });
    }
    const key = readOrdinaryFile(context.gitDirectory, keyPath).trim();
    if (!SHA256_PATTERN.test(key)) throw new Error('Task reset authority authentication key is invalid.');
    return Buffer.from(key, 'hex');
}

function signature(record: Omit<AuthorityRecord, 'hmac_sha256'>, key: Buffer): Buffer {
    return createHmac('sha256', key).update(JSON.stringify(record)).digest();
}

function persistRecord(context: AuthorityContext, record: Omit<AuthorityRecord, 'hmac_sha256'>, key: Buffer): void {
    const filePath = path.join(context.storageRoot, `${record.authority_id}.json`);
    writeContainedFile(context.gitDirectory, filePath,
        JSON.stringify({ ...record, hmac_sha256: signature(record, key).toString('hex') }) + '\n');
    fs.chmodSync(filePath, 0o600);
}

function claimAuthorityConsumption(context: AuthorityContext, authorityId: string): void {
    const claimPath = path.join(context.storageRoot, `${authorityId}.consumed`);
    const binding = bindContainedDestination(context.gitDirectory, claimPath);
    let descriptor: number;
    try {
        descriptor = fs.openSync(claimPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('Task reset one-action authority replay is rejected by its consumption claim.');
        }
        throw error;
    }
    try {
        fs.writeFileSync(descriptor, sha256(authorityId) + '\n');
        fs.fsyncSync(descriptor);
        assertExistingPathIdentity(binding);
        bindContainedDestination(context.gitDirectory, claimPath);
        const opened = completePathFileIdentitySync(claimPath, fs.fstatSync(descriptor));
        const current = lstatFileIdentitySync(claimPath);
        if (!opened.isFile() || opened.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino
            || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
            throw new Error('Task reset consumption claim identity changed before effects.');
        }
    } finally {
        // Keep even an incomplete claim: interrupted admission must never reopen authority.
        fs.closeSync(descriptor);
    }
}

export function withTaskResetMutationLock<T>(repoRoot: string, taskId: string, callback: () => T): T {
    assertValidTaskId(taskId);
    const root = fs.realpathSync.native(path.resolve(repoRoot));
    const locks = joinOrchestratorPath(root, 'runtime/task-reset-authority-locks');
    ensureContainedDirectory(root, locks);
    const lockPath = path.join(locks, `${taskId}.lock`);
    const binding = bindContainedDestination(root, locks);
    bindContainedDestination(root, lockPath);
    return withFilesystemLock(lockPath, { requireKnownDeadOwner: true }, () => {
        assertExistingPathIdentity(binding);
        return callback();
    }).result;
}

export function prepareTaskResetOneActionAuthority(options: {
    repoRoot: string;
    action: TaskResetAuthorityAction;
    operatorConfirmed: unknown;
    operatorConfirmedAtUtc: unknown;
}): string {
    validateFreshOperatorConfirmation({ actionLabel: 'One-action task reset',
        confirmed: parseOperatorConfirmationYes(options.operatorConfirmed),
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(), requireConfirmedAtUtc: true,
        instruction: 'Confirm this workspace, task and reset target; no persistent setting is changed.' });
    return withTaskResetMutationLock(options.repoRoot, options.action.taskId, () => {
        const context = resolveContext(options.repoRoot);
        const actionHash = actionDigest(context.root, options.action);
        const key = permissionKey(context, true);
        const issuedAt = Date.now();
        const id = randomBytes(32).toString('hex');
        persistRecord(context, { schema_version: 1, domain: DOMAIN, authority_id: id,
            workspace_identity: context.workspaceIdentity, action_sha256: actionHash,
            operator_confirmed_at_utc: String(options.operatorConfirmedAtUtc).trim(),
            issued_at_ms: issuedAt, expires_at_ms: issuedAt + OPERATOR_CONFIRMATION_MAX_AGE_MS, consumed: false }, key);
        return id;
    });
}

export function withTaskResetOneActionAuthority<T>(options: {
    repoRoot: string;
    authorityId: unknown;
    action: () => TaskResetAuthorityAction;
    taskId: string;
}, callback: () => T): T {
    if (typeof options.authorityId !== 'string' || !SHA256_PATTERN.test(options.authorityId)) {
        throw new Error('Task reset one-action authority ID is malformed.');
    }
    return withTaskResetMutationLock(options.repoRoot, options.taskId, () => {
        const context = resolveContext(options.repoRoot);
        const key = permissionKey(context, false);
        const parsed = JSON.parse(readOrdinaryFile(context.gitDirectory,
            path.join(context.storageRoot, `${options.authorityId}.json`))) as AuthorityRecord;
        const { hmac_sha256: mac, ...unsigned } = parsed;
        if (typeof mac !== 'string' || !SHA256_PATTERN.test(mac)
            || !timingSafeEqual(signature(unsigned, key), Buffer.from(mac, 'hex'))) {
            throw new Error('Task reset one-action authority authentication failed.');
        }
        const action = options.action();
        if (parsed.schema_version !== 1 || parsed.domain !== DOMAIN || parsed.authority_id !== options.authorityId
            || parsed.workspace_identity !== context.workspaceIdentity || action.taskId !== options.taskId
            || parsed.action_sha256 !== actionDigest(context.root, action)) {
            throw new Error('Task reset one-action authority workspace, task or action mismatch.');
        }
        const now = Date.now();
        if (!Number.isSafeInteger(parsed.issued_at_ms) || !Number.isSafeInteger(parsed.expires_at_ms)
            || parsed.expires_at_ms !== parsed.issued_at_ms + OPERATOR_CONFIRMATION_MAX_AGE_MS
            || now < parsed.issued_at_ms || now >= parsed.expires_at_ms) {
            throw new Error('Task reset one-action authority is stale or not yet valid.');
        }
        if (parsed.consumed !== false) throw new Error('Task reset one-action authority replay is rejected.');
        // Consume before effects; interruption or partial failure requires new explicit authority.
        claimAuthorityConsumption(context, parsed.authority_id);
        persistRecord(context, { ...unsigned, consumed: true }, key);
        return callback();
    });
}
