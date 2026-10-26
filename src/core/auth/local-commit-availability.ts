import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../contained-filesystem';
import { joinOrchestratorPath } from '../orchestrator-paths';
import { assertWorkflowTransactionReadable } from '../workflow-transaction-state';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import { isPlainRecord } from '../records';
import { statFileIdentitySync } from '../file-stat';
import { observedInvocationValue, readInvocationFileContent, readInvocationPathObservation } from '../invocation-file-observation';
import type { InvocationObservedValue } from '../invocation-file-observation';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead,
    registerInvocationDependency } from '../invocation-read-observation';
import { readNativeRealpath } from '../paths';
import { countNextStepWork } from '../next-step-measurement';

export interface LocalCommitAvailability {
    enabled: boolean;
    configuredEnabled: boolean;
    auditedEnablement: boolean;
    disabledReason: string | null;
    remediationCommand: string;
}

interface PermissionContext {
    gitDirectory: string;
    keyPath: string;
    workspaceIdentity: string;
}

const AUTHENTICATION_DOMAIN = 'garda.local-commit.workflow.v1';
const KEY_RELATIVE_PATH = 'garda-private/local-commit-key';
const MIGRATION_KEY_RELATIVE_PATH = 'garda-private/workflow-migration-key';
const MIGRATION_AUTHENTICATION_DOMAIN = 'garda.workflow-migration.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_AUDIT_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_LINE_BYTES = 64 * 1024;
const AUDIT_READ_CHUNK_BYTES = 64 * 1024;

type PermissionWorkspaceIdentity = Pick<fs.BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>;
const PERMISSION_WORKSPACE_IDENTITIES = createInvocationReadMemoKey<InvocationObservedValue<PermissionWorkspaceIdentity>>(
    'permission-native-workspace-identities'
);

function capturePermissionWorkspaceIdentity(root: string): InvocationObservedValue<PermissionWorkspaceIdentity> {
    try {
        // The authentication protocol uses raw stat values, including a zero Windows dev.
        // Descriptor-completed Q2 identities protect paths but are not HMAC payload fields.
        const identity = fs.statSync(root, { bigint: true });
        return Object.freeze({ value: Object.freeze({ dev: identity.dev, ino: identity.ino, birthtimeNs: identity.birthtimeNs }) });
    } catch (error: unknown) {
        return Object.freeze({ error });
    }
}

function readPermissionWorkspaceIdentity(root: string, observeReads: boolean): PermissionWorkspaceIdentity {
    if (!observeReads || !isInvocationReadObservationActive()) return fs.statSync(root, { bigint: true });
    return observedInvocationValue(memoizeInvocationRead(PERMISSION_WORKSPACE_IDENTITIES, root, () => {
        readInvocationPathObservation(root);
        countNextStepWork('permission_workspace_identity_observation:' + root);
        const original = capturePermissionWorkspaceIdentity(root);
        registerInvocationDependency(original, () => {
            countNextStepWork('permission_workspace_identity_final_validation:' + root);
            const current = capturePermissionWorkspaceIdentity(root);
            const unchanged = 'error' in original || 'error' in current
                ? 'error' in original && 'error' in current
                    && String((original.error as NodeJS.ErrnoException)?.code || original.error)
                        === String((current.error as NodeJS.ErrnoException)?.code || current.error)
                : original.value.dev === current.value.dev && original.value.ino === current.value.ino
                    && original.value.birthtimeNs === current.value.birthtimeNs;
            if (!unchanged) throw new Error('Invocation permission workspace identity changed: ' + root);
        });
        return original;
    }).value);
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedPath(value: string): string {
    const resolved = path.resolve(value).replace(/\\/gu, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readPermissionText(filePath: string, observeReads: boolean): string {
    const content = observeReads ? readInvocationFileContent(filePath) : null;
    if (!content) return fs.readFileSync(filePath, 'utf8');
    if (content.size <= 128 * 1024 * 1024) return content.copyBytes().toString('utf8');
    // Preserve the native reader's size contract; Q2 retains only a digest above its byte bound.
    const bytes = fs.readFileSync(filePath);
    if (createHash('sha256').update(bytes).digest('hex') !== content.sha256)
        throw new Error('Permission input changed during invocation capture.');
    return bytes.toString('utf8');
}

function resolvePermissionContext(repoRoot: string, keyRelativePath = KEY_RELATIVE_PATH, observeReads = false): PermissionContext {
    const resolvedRoot = path.resolve(repoRoot);
    const root = observeReads ? readNativeRealpath(resolvedRoot) : fs.realpathSync.native(resolvedRoot);
    const gitPath = path.join(root, '.git');
    const gitObservation = observeReads ? readInvocationPathObservation(gitPath) : null;
    const gitStat = gitObservation ? observedInvocationValue(gitObservation.stat) : fs.lstatSync(gitPath);
    if (gitStat.isSymbolicLink()) throw new Error('Local commit permission rejects symbolic Git metadata.');
    const pointer = gitStat.isFile() ? readPermissionText(gitPath, observeReads).trim().match(/^gitdir:\s*(.+)$/u) : null;
    const gitDirectory = gitStat.isDirectory() ? gitPath : pointer ? path.resolve(root, pointer[1]) : '';
    const directoryObservation = observeReads && gitDirectory ? readInvocationPathObservation(gitDirectory) : null;
    if (!gitDirectory || !(directoryObservation ? observedInvocationValue(directoryObservation.stat) : fs.lstatSync(gitDirectory)).isDirectory())
        throw new Error('Local commit permission requires a Git workspace.');
    const canonicalGitDirectory = observeReads ? readNativeRealpath(gitDirectory) : fs.realpathSync.native(gitDirectory);
    const keyPath = path.join(canonicalGitDirectory, keyRelativePath);
    if (observeReads) readInvocationPathObservation(keyPath);
    bindContainedDestination(canonicalGitDirectory, keyPath);
    const identity = readPermissionWorkspaceIdentity(root, observeReads);
    return { gitDirectory: canonicalGitDirectory, keyPath,
        workspaceIdentity: sha256(JSON.stringify([normalizedPath(root), normalizedPath(canonicalGitDirectory),
            String(identity.dev), String(identity.ino), String(identity.birthtimeNs)])) };
}

function readPermissionKey(context: PermissionContext, observeReads = false): Buffer | null {
    const observation = observeReads ? readInvocationPathObservation(context.keyPath) : null;
    if (observation ? 'error' in observation.targetStat : !fs.existsSync(context.keyPath)) return null;
    bindContainedDestination(context.gitDirectory, context.keyPath);
    const value = readPermissionText(context.keyPath, observeReads).trim();
    if (!SHA256_PATTERN.test(value)) throw new Error('Local commit authentication key is invalid.');
    return Buffer.from(value, 'hex');
}

function rotatePermissionKey(context: PermissionContext): Buffer {
    ensureContainedDirectory(context.gitDirectory, path.dirname(context.keyPath));
    const key = randomBytes(32);
    writeContainedFile(context.gitDirectory, context.keyPath, `${key.toString('hex')}\n`);
    fs.chmodSync(context.keyPath, 0o600);
    return key;
}

function authenticationPayload(record: Record<string, unknown>, workspaceIdentity: string): string {
    const unsigned = { ...record };
    delete unsigned.local_commit_authentication;
    return JSON.stringify({ domain: AUTHENTICATION_DOMAIN, workspace_identity: workspaceIdentity, record: unsigned });
}

export function authenticateLocalCommitWorkflowAudit<TRecord extends Record<string, unknown>>(
    repoRoot: string, record: TRecord, rotate: boolean
): TRecord & { local_commit_authentication?: Record<string, string> } {
    let context: PermissionContext;
    try { context = resolvePermissionContext(repoRoot); }
    catch (error) {
        if (rotate) throw error;
        return record;
    }
    // Rotation is a revocation barrier outside copied live/runtime state. A failed
    // publication deliberately leaves old grants invalid rather than resurrecting them.
    const key = rotate ? rotatePermissionKey(context) : readPermissionKey(context);
    if (!key) return record;
    return { ...record, local_commit_authentication: {
        workspace_identity_sha256: context.workspaceIdentity,
        hmac_sha256: createHmac('sha256', key).update(authenticationPayload(record, context.workspaceIdentity)).digest('hex')
    } };
}

function isAuthenticatedAudit(record: Record<string, unknown>, context: PermissionContext, key: Buffer): boolean {
    const authentication = record.local_commit_authentication;
    if (!isPlainRecord(authentication) || authentication.workspace_identity_sha256 !== context.workspaceIdentity
        || typeof authentication.hmac_sha256 !== 'string' || !SHA256_PATTERN.test(authentication.hmac_sha256)) return false;
    const expected = createHmac('sha256', key).update(authenticationPayload(record, context.workspaceIdentity)).digest();
    return timingSafeEqual(expected, Buffer.from(authentication.hmac_sha256, 'hex'));
}

function migrationAuthenticationPayload(record: Record<string, unknown>, workspaceIdentity: string): string {
    const unsigned = { ...record };
    delete unsigned.local_commit_authentication;
    delete unsigned.workflow_migration_authentication;
    return JSON.stringify({ domain: MIGRATION_AUTHENTICATION_DOMAIN, workspace_identity: workspaceIdentity, record: unsigned });
}

export function authenticateWorkflowMigration<TRecord extends Record<string, unknown>>(
    repoRoot: string, record: TRecord
): TRecord & { workflow_migration_authentication: Record<string, string>; local_commit_authentication?: Record<string, string> } {
    // Migration provenance survives permission revocation; it cannot itself enable a commit grant.
    const context = resolvePermissionContext(repoRoot, MIGRATION_KEY_RELATIVE_PATH);
    const key = readPermissionKey(context) ?? rotatePermissionKey(context);
    const signed = { ...record, workflow_migration_authentication: {
        workspace_identity_sha256: context.workspaceIdentity,
        hmac_sha256: createHmac('sha256', key).update(migrationAuthenticationPayload(record, context.workspaceIdentity)).digest('hex')
    } };
    return authenticateLocalCommitWorkflowAudit(repoRoot, signed, false);
}

export function isAuthenticatedWorkflowMigration(repoRoot: string, record: Record<string, unknown>): boolean {
    if (record.event_source !== 'workflow-config-set' || record.command !== 'lifecycle configuration migration'
        || record.mutation_source !== 'lifecycle' || record.migration_version !== 1
        || record.permissions_preserved !== true) return false;
    try {
        const context = resolvePermissionContext(repoRoot, MIGRATION_KEY_RELATIVE_PATH, true);
        const key = readPermissionKey(context, true);
        const authentication = record.workflow_migration_authentication;
        if (!key || !isPlainRecord(authentication)
            || authentication.workspace_identity_sha256 !== context.workspaceIdentity
            || typeof authentication.hmac_sha256 !== 'string' || !SHA256_PATTERN.test(authentication.hmac_sha256)) return false;
        const expected = createHmac('sha256', key).update(migrationAuthenticationPayload(record, context.workspaceIdentity)).digest();
        return timingSafeEqual(expected, Buffer.from(authentication.hmac_sha256, 'hex'));
    } catch {
        return false;
    }
}

export function localCommitReceiptPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, 'live/config/local-commit-enablement-receipt.json');
}

function* readAuditWindow(auditPath: string, start: number): Generator<{ line: string; offset: number }> {
    const descriptor = fs.openSync(auditPath, 'r');
    try {
        const initial = fs.fstatSync(descriptor);
        if (!initial.isFile() || start > initial.size || initial.size - start > MAX_AUDIT_WINDOW_BYTES) {
            throw new Error('Local commit audit verification exceeds its 8 MiB window; renew the audited grant.');
        }
        const chunk = Buffer.alloc(AUDIT_READ_CHUNK_BYTES);
        if (start > 0 && (fs.readSync(descriptor, chunk, 0, 1, start - 1) !== 1 || chunk[0] !== 10)) {
            throw new Error('Local commit audit grant offset is not a record boundary.');
        }
        let position = start;
        let lineOffset = start;
        let pending = Buffer.alloc(0);
        while (position < initial.size) {
            const length = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, initial.size - position), position);
            if (length === 0) throw new Error('Local commit audit was truncated during verification.');
            position += length;
            const bytes = Buffer.concat([pending, chunk.subarray(0, length)]);
            let from = 0;
            for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, from)) {
                if (end - from > MAX_AUDIT_LINE_BYTES) throw new Error('Local commit audit record exceeds its 64 KiB budget.');
                yield { line: bytes.subarray(from, end).toString('utf8').trim(), offset: lineOffset };
                lineOffset += end - from + 1;
                from = end + 1;
            }
            pending = bytes.subarray(from);
            if (pending.length > MAX_AUDIT_LINE_BYTES) throw new Error('Local commit audit record exceeds its 64 KiB budget.');
        }
        if (pending.length > 0) throw new Error('Local commit audit ends with an incomplete record.');
        const current = statFileIdentitySync(auditPath);
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size
            || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
            throw new Error('Local commit audit changed during verification.');
        }
    } finally { fs.closeSync(descriptor); }
}

function hasAuthenticatedEnablement(repoRoot: string, configPath: string, configHash: string): boolean {
    const context = resolvePermissionContext(repoRoot);
    const key = readPermissionKey(context);
    if (!key) return false;
    const receiptPath = localCommitReceiptPath(repoRoot);
    bindContainedDestination(repoRoot, receiptPath);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as unknown;
    if (!isPlainRecord(receipt) || receipt.event_source !== 'local-commit-enablement-receipt'
        || (receipt.schema_version !== 1 && receipt.schema_version !== 2)
        || receipt.enabled !== true || typeof receipt.audit_record_sha256 !== 'string'
        || !SHA256_PATTERN.test(receipt.audit_record_sha256)) return false;
    const indexed = receipt.schema_version === 2;
    const start = indexed ? receipt.audit_record_byte_offset : 0;
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) return false;
    const auditPath = joinOrchestratorPath(repoRoot, 'runtime/workflow-config-audit.jsonl');
    bindContainedDestination(repoRoot, auditPath);
    let grantFound = false;
    let expectedHash: unknown = null;
    for (const { line, offset } of readAuditWindow(auditPath, start)) {
        if (!line) continue;
        if (!grantFound) {
            if (sha256(line) !== receipt.audit_record_sha256) {
                if (indexed) return false;
                continue;
            }
            grantFound = true;
        }
        const record = JSON.parse(line) as unknown;
        if (!isPlainRecord(record)) return false;
        if (normalizedPath(String(record.config_path || '')) !== normalizedPath(configPath)) {
            if (expectedHash === null) return false;
            continue;
        }
        if (record.event_source !== 'workflow-config-set'
            || (record.command !== 'workflow set' && !isAuthenticatedWorkflowMigration(repoRoot, record))
            || !isAuthenticatedAudit(record, context, key)) return false;
        if (expectedHash === null) {
            if (!Array.isArray(record.changed_fields) || !record.changed_fields.includes('local_commit.enabled')
                || record.local_commit_enabled !== true || receipt.after_sha256 !== record.after_sha256
                || ((indexed || record.audit_record_byte_offset !== undefined) && record.audit_record_byte_offset !== offset)) return false;
        } else if (record.before_sha256 !== expectedHash) return false;
        expectedHash = record.after_sha256;
    }
    return grantFound && expectedHash === configHash;
}

export function resolveLocalCommitAvailability(repoRoot: string): LocalCommitAvailability {
    const configPath = joinOrchestratorPath(repoRoot, 'live/config/workflow-config.json');
    const result: LocalCommitAvailability = { enabled: false, configuredEnabled: false, auditedEnablement: false,
        disabledReason: null,
        remediationCommand: 'garda workflow set --local-commit-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."' };
    try {
        assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(configPath))));
        bindContainedDestination(repoRoot, configPath);
        const text = fs.readFileSync(configPath, 'utf8');
        const config = validateWorkflowConfig(JSON.parse(text));
        result.configuredEnabled = isPlainRecord(config.local_commit) && config.local_commit.enabled === true;
        if (!result.configuredEnabled) result.disabledReason = 'workflow-config.local_commit.enabled is false or omitted';
        else {
            result.auditedEnablement = hasAuthenticatedEnablement(repoRoot, configPath, sha256(text));
            result.enabled = result.auditedEnablement;
            result.disabledReason = result.enabled ? null : 'Local commit enablement is missing, revoked, unaudited or belongs to another workspace';
        }
    } catch (error) { result.disabledReason = `Local commit permission is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    return result;
}
