import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../../core/filesystem';
import { validateFreshOperatorConfirmation } from '../../../core/operator-confirmation';
import { resolveActiveTaskIds } from '../../../core/task-queue/active-task-state';
import { writeProtectedControlPlaneManifest } from '../../../gates/protected-control-plane/protected-control-plane';
import { sha256Text } from './review-catalog-state';
import type {
    ReviewCatalogManagedFileChange,
    ReviewCatalogManagementPlan,
    ReviewCatalogTransactionResult
} from './review-catalog-types';

export type { ReviewCatalogManagementPlan } from './review-catalog-types';

const MANAGED_CONFIG_FILE_NAMES = new Set([
    'review-catalog.json',
    'review-capabilities.json',
    'profiles.json'
]);

export interface CommitReviewCatalogManagementPlanOptions {
    repoRoot: string;
    bundleRoot: string;
    plan: ReviewCatalogManagementPlan;
    expectedStateSha256: string;
    expectedPlanSha256: string;
    confirmationReceiptSha256: string;
    readCurrentStateSha256: () => string;
    writeFile?: (filePath: string, content: string) => void;
}

export interface IssueReviewCatalogConfirmationOptions {
    repoRoot: string;
    bundleRoot: string;
    plan: ReviewCatalogManagementPlan;
    expectedStateSha256: string;
    expectedPlanSha256: string;
    operatorConfirmedAtUtc: string;
    readCurrentStateSha256: () => string;
}

export interface ReviewCatalogConfirmationResult {
    status: 'CONFIRMED';
    confirmation_receipt_sha256: string;
    confirmation_receipt_path: string;
    confirmed_at_utc: string;
}

interface ReviewCatalogConfirmationPayload {
    schema_version: 2;
    event_source: 'review-catalog-management-confirmation';
    operator_context: 'no_active_agent_tasks';
    confirmation_id: string;
    issued_at_utc: string;
    operator_confirmed_at_utc: string;
    operation: string;
    review_id: string | null;
    before_state_sha256: string;
    plan_sha256: string;
}

function normalizeSha256(value: string, label: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(normalized)) {
        throw new Error(`${label} must be a SHA-256 hex string from review-catalog preview.`);
    }
    return normalized;
}

function normalizeOutputPath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/gu, '/');
}

export function sameManagedReviewCatalogFileIdentity(
    left: Pick<fs.BigIntStats, 'dev' | 'ino'>,
    right: Pick<fs.BigIntStats, 'dev' | 'ino'>,
    platform: NodeJS.Platform = process.platform
): boolean {
    if (left.ino !== right.ino) return false;
    if (left.dev === right.dev) return true;
    // Node 22 on Windows can report dev=0 for path-based stats while fstat
    // returns the volume id for the same file. Callers have already pinned the
    // real parent directory inside the bundle, so an exact bigint inode match
    // is sufficient only for that Windows compatibility case.
    return platform === 'win32' && (left.dev === 0n || right.dev === 0n);
}

function ensureRealDirectoryInsideBundle(bundleRoot: string, directoryPath: string, label: string): void {
    const absoluteBundleRoot = path.resolve(bundleRoot);
    const absoluteDirectoryPath = path.resolve(directoryPath);
    const relativePath = path.relative(absoluteBundleRoot, absoluteDirectoryPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`${label} must stay inside the review catalog bundle.`);
    }

    const resolvedBundleRoot = fs.realpathSync.native(absoluteBundleRoot);
    let currentPath = absoluteBundleRoot;
    let expectedRealPath = path.resolve(resolvedBundleRoot);
    const segments = relativePath.split(path.sep).filter(Boolean);
    for (const segment of segments) {
        currentPath = path.join(currentPath, segment);
        expectedRealPath = path.join(expectedRealPath, segment);
        if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath);
        }
        const identity = fs.lstatSync(currentPath);
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
            throw new Error(`${label} must be a real directory.`);
        }
        const actualRealPath = fs.realpathSync.native(currentPath);
        if (path.resolve(actualRealPath) !== path.resolve(expectedRealPath)) {
            throw new Error(`${label} resolves outside the review catalog bundle.`);
        }
    }
}

function assertExistingRealDirectoryInsideBundle(bundleRoot: string, directoryPath: string, label: string): void {
    const absoluteBundleRoot = path.resolve(bundleRoot);
    const absoluteDirectoryPath = path.resolve(directoryPath);
    const relativePath = path.relative(absoluteBundleRoot, absoluteDirectoryPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`${label} must stay inside the review catalog bundle.`);
    }
    const identity = fs.lstatSync(absoluteDirectoryPath);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new Error(`${label} must be a real directory.`);
    }
    const expectedRealPath = path.resolve(fs.realpathSync.native(absoluteBundleRoot), relativePath);
    const actualRealPath = path.resolve(fs.realpathSync.native(absoluteDirectoryPath));
    if (actualRealPath !== expectedRealPath) {
        throw new Error(`${label} resolves outside the review catalog bundle.`);
    }
}

function assertManagedConfigDirectoryCurrent(bundleRoot: string): void {
    assertExistingRealDirectoryInsideBundle(
        bundleRoot,
        path.join(bundleRoot, 'live', 'config'),
        'Review catalog managed config directory'
    );
}

function assertManagedChanges(bundleRoot: string, changes: readonly ReviewCatalogManagedFileChange[]): void {
    assertManagedConfigDirectoryCurrent(bundleRoot);
    const expectedConfigDir = path.resolve(bundleRoot, 'live', 'config');
    const seen = new Set<string>();
    for (const change of changes) {
        const resolvedPath = path.resolve(change.path);
        if (
            path.dirname(resolvedPath) !== expectedConfigDir
            || !MANAGED_CONFIG_FILE_NAMES.has(path.basename(resolvedPath))
        ) {
            throw new Error(`Review catalog transaction rejected out-of-scope path '${change.path}'.`);
        }
        const foldedPath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
        if (seen.has(foldedPath)) throw new Error(`Review catalog transaction contains duplicate path '${change.path}'.`);
        seen.add(foldedPath);
        if (change.before_text !== null && sha256Text(change.before_text) === sha256Text(change.after_text)) {
            throw new Error(`Review catalog transaction contains a no-op file replacement for '${change.path}'.`);
        }
    }
}

function acquireTransactionLock(bundleRoot: string): { lockPath: string; lockFd: number } {
    const runtimeDir = path.join(bundleRoot, 'runtime');
    ensureRealDirectoryInsideBundle(bundleRoot, runtimeDir, 'Review catalog runtime directory');
    const lockPath = path.join(runtimeDir, 'review-catalog-management.lock');
    let lockFd: number | null = null;
    try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, timestamp_utc: new Date().toISOString() })}\n`, 'utf8');
        fs.fsyncSync(lockFd);
        return { lockPath, lockFd };
    } catch (error: unknown) {
        if (lockFd !== null) {
            try {
                fs.closeSync(lockFd);
            } finally {
                if (fs.existsSync(lockPath)) {
                    const identity = fs.lstatSync(lockPath);
                    if (identity.isFile() && !identity.isSymbolicLink() && identity.nlink === 1) {
                        fs.unlinkSync(lockPath);
                    }
                }
            }
        }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('Another review-catalog management transaction is active; concurrent mutation rejected.');
        }
        throw error;
    }
}

function releaseTransactionLock(lockPath: string, lockFd: number): void {
    fs.closeSync(lockFd);
    const identity = fs.lstatSync(lockPath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
        throw new Error('Review catalog transaction lock changed before release.');
    }
    fs.unlinkSync(lockPath);
}

function runWithTransactionLock<T>(
    bundleRoot: string,
    combinedFailureMessage: string,
    operation: () => T
): T {
    const { lockPath, lockFd } = acquireTransactionLock(bundleRoot);
    let outcome: { value: T } | null = null;
    let primaryError: unknown;
    let lockReleaseError: unknown;
    let hasPrimaryError = false;
    let hasLockReleaseError = false;
    try {
        outcome = { value: operation() };
    } catch (error: unknown) {
        primaryError = error;
        hasPrimaryError = true;
    } finally {
        try {
            releaseTransactionLock(lockPath, lockFd);
        } catch (error: unknown) {
            lockReleaseError = error;
            hasLockReleaseError = true;
        }
    }
    if (hasPrimaryError && hasLockReleaseError) {
        throw new AggregateError([primaryError, lockReleaseError], combinedFailureMessage);
    }
    if (hasPrimaryError) {
        throw primaryError;
    }
    if (hasLockReleaseError) {
        throw lockReleaseError;
    }
    if (outcome === null) {
        throw new Error('Review catalog transaction completed without a result.');
    }
    return outcome.value;
}

function resolveConfirmationDirectory(bundleRoot: string, consumed = false): string {
    const confirmationRoot = path.join(bundleRoot, 'runtime', 'review-catalog-confirmations');
    ensureRealDirectoryInsideBundle(bundleRoot, confirmationRoot, 'Review catalog confirmation directory');
    if (!consumed) return confirmationRoot;
    const consumedRoot = path.join(confirmationRoot, 'consumed');
    ensureRealDirectoryInsideBundle(bundleRoot, consumedRoot, 'Review catalog consumed-confirmation directory');
    return consumedRoot;
}

function writeExclusiveReceipt(receiptPath: string, content: string): void {
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(
        receiptPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
        0o600
    );
    try {
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
        const openedIdentity = fs.fstatSync(fd, { bigint: true });
        const pathIdentity = fs.lstatSync(receiptPath, { bigint: true });
        if (
            !openedIdentity.isFile()
            || !pathIdentity.isFile()
            || pathIdentity.isSymbolicLink()
            || openedIdentity.nlink !== 1n
            || pathIdentity.nlink !== 1n
            || !sameManagedReviewCatalogFileIdentity(openedIdentity, pathIdentity)
        ) {
            throw new Error('Review catalog confirmation receipt identity changed while writing.');
        }
    } finally {
        fs.closeSync(fd);
    }
}

function buildConfirmationPayload(
    plan: ReviewCatalogManagementPlan,
    operatorConfirmedAtUtc: string
): ReviewCatalogConfirmationPayload {
    return {
        schema_version: 2,
        event_source: 'review-catalog-management-confirmation',
        operator_context: 'no_active_agent_tasks',
        confirmation_id: randomUUID(),
        issued_at_utc: new Date().toISOString(),
        operator_confirmed_at_utc: operatorConfirmedAtUtc,
        operation: plan.operation,
        review_id: plan.review_id ?? null,
        before_state_sha256: plan.before_state_sha256,
        plan_sha256: plan.plan_sha256
    };
}

function consumeConfirmationReceipt(
    bundleRoot: string,
    plan: ReviewCatalogManagementPlan,
    rawReceiptSha256: string
): void {
    const receiptSha256 = normalizeSha256(rawReceiptSha256, '--confirmation-receipt-sha256');
    const confirmationRoot = resolveConfirmationDirectory(bundleRoot);
    const receiptPath = path.join(confirmationRoot, `${receiptSha256}.json`);
    if (!fs.existsSync(receiptPath)) {
        throw new Error('Review catalog confirmation receipt is missing or was already consumed.');
    }
    const identity = fs.lstatSync(receiptPath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
        throw new Error('Review catalog confirmation receipt must be a unique regular file.');
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    } catch {
        throw new Error('Review catalog confirmation receipt is not valid JSON.');
    }
    const embeddedReceiptSha256 = String(parsed.receipt_sha256 || '').trim().toLowerCase();
    const { receipt_sha256: _receiptSha256, ...payload } = parsed;
    if (
        embeddedReceiptSha256 !== receiptSha256
        || sha256Text(JSON.stringify(payload)) !== receiptSha256
    ) {
        throw new Error('Review catalog confirmation receipt integrity check failed.');
    }
    if (
        parsed.schema_version !== 2
        || parsed.event_source !== 'review-catalog-management-confirmation'
        || parsed.operator_context !== 'no_active_agent_tasks'
        || typeof parsed.confirmation_id !== 'string'
        || typeof parsed.issued_at_utc !== 'string'
        || typeof parsed.operator_confirmed_at_utc !== 'string'
    ) {
        throw new Error('Review catalog confirmation receipt has an invalid contract.');
    }
    validateFreshOperatorConfirmation({
        actionLabel: 'review-catalog apply receipt',
        confirmed: true,
        confirmedAtUtc: parsed.operator_confirmed_at_utc,
        requireConfirmedAtUtc: true,
        instruction: 'Obtain a new operator confirmation receipt for the current preview.'
    });
    if (
        parsed.operation !== plan.operation
        || String(parsed.review_id ?? '') !== String(plan.review_id ?? '')
        || parsed.before_state_sha256 !== plan.before_state_sha256
        || parsed.plan_sha256 !== plan.plan_sha256
    ) {
        throw new Error('Review catalog confirmation receipt does not match the current preview plan.');
    }
    const consumedRoot = resolveConfirmationDirectory(bundleRoot, true);
    const consumedPath = path.join(consumedRoot, `${receiptSha256}.json`);
    if (fs.existsSync(consumedPath)) {
        throw new Error('Review catalog confirmation receipt was already consumed.');
    }
    fs.renameSync(receiptPath, consumedPath);
}

function requireOperatorOnlyContext(repoRoot: string, bundleRoot: string, actionLabel: string): void {
    const activeTaskIds = [...resolveActiveTaskIds(repoRoot, bundleRoot)].sort((left, right) => left.localeCompare(right));
    if (activeTaskIds.length > 0) {
        throw new Error(
            `${actionLabel} rejects self-confirmation while agent task state is active `
            + `(${activeTaskIds.join(', ')}). Complete or stop the task, then obtain fresh operator approval.`
        );
    }
}

export function issueReviewCatalogConfirmationReceipt(
    options: IssueReviewCatalogConfirmationOptions
): ReviewCatalogConfirmationResult {
    const expectedStateSha256 = normalizeSha256(options.expectedStateSha256, '--expected-state-sha256');
    const expectedPlanSha256 = normalizeSha256(options.expectedPlanSha256, '--expected-plan-sha256');
    if (expectedStateSha256 !== options.plan.before_state_sha256) {
        throw new Error('Expected state SHA-256 does not match the review-catalog preview baseline.');
    }
    if (expectedPlanSha256 !== options.plan.plan_sha256) {
        throw new Error('Expected plan SHA-256 does not match the review-catalog preview plan.');
    }
    validateFreshOperatorConfirmation({
        actionLabel: 'review-catalog confirmation',
        confirmed: true,
        confirmedAtUtc: options.operatorConfirmedAtUtc,
        requireConfirmedAtUtc: true,
        instruction: 'Obtain explicit operator confirmation after inspecting the preview.'
    });
    requireOperatorOnlyContext(options.repoRoot, options.bundleRoot, 'Review catalog confirmation');
    const issueConfirmationReceipt = (): ReviewCatalogConfirmationResult => {
        requireOperatorOnlyContext(options.repoRoot, options.bundleRoot, 'Review catalog confirmation');
        if (options.readCurrentStateSha256() !== expectedStateSha256) {
            throw new Error('Managed review configuration changed after preview; stale preview cannot be confirmed.');
        }
        const payload = buildConfirmationPayload(options.plan, options.operatorConfirmedAtUtc);
        const receiptSha256 = sha256Text(JSON.stringify(payload));
        const confirmationRoot = resolveConfirmationDirectory(options.bundleRoot);
        const receiptPath = path.join(confirmationRoot, `${receiptSha256}.json`);
        writeExclusiveReceipt(
            receiptPath,
            `${JSON.stringify({ ...payload, receipt_sha256: receiptSha256 }, null, 2)}\n`
        );
        return {
            status: 'CONFIRMED',
            confirmation_receipt_sha256: receiptSha256,
            confirmation_receipt_path: normalizeOutputPath(receiptPath),
            confirmed_at_utc: options.operatorConfirmedAtUtc
        };
    };
    return runWithTransactionLock(
        options.bundleRoot,
        'Review catalog confirmation failed and its lock could not be released safely.',
        issueConfirmationReceipt
    );
}

function appendAuditRecord(
    bundleRoot: string,
    auditPath: string,
    record: Record<string, unknown>
): void {
    ensureRealDirectoryInsideBundle(bundleRoot, path.dirname(auditPath), 'Review catalog audit directory');
    const existed = fs.existsSync(auditPath);
    if (existed) {
        const identity = fs.lstatSync(auditPath);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
            throw new Error('Review catalog management audit must be a unique regular file.');
        }
    }
    const createFlags = existed ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(
        auditPath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | createFlags | noFollowFlag,
        0o600
    );
    try {
        const openedIdentity = fs.fstatSync(fd, { bigint: true });
        const pathIdentity = fs.lstatSync(auditPath, { bigint: true });
        if (
            !openedIdentity.isFile()
            || !pathIdentity.isFile()
            || pathIdentity.isSymbolicLink()
            || openedIdentity.nlink !== 1n
            || pathIdentity.nlink !== 1n
            || !sameManagedReviewCatalogFileIdentity(openedIdentity, pathIdentity)
        ) {
            throw new Error('Review catalog management audit identity changed while opening.');
        }
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function createBackup(
    bundleRoot: string,
    transactionId: string,
    plan: ReviewCatalogManagementPlan
): string {
    const backupsRoot = path.join(bundleRoot, 'runtime', 'review-catalog-management-backups');
    ensureRealDirectoryInsideBundle(bundleRoot, backupsRoot, 'Review catalog backup root');
    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const backupPath = path.join(backupsRoot, `${timestamp}-${transactionId}`);
    fs.mkdirSync(backupPath, { recursive: false });
    const entries = plan.changes.map((change) => {
        if (change.before_text !== null) {
            writeFileAtomically(path.join(backupPath, path.basename(change.path)), change.before_text, { encoding: 'utf8' });
        }
        return {
            config_path: change.relative_path,
            existed: change.before_text !== null,
            before_sha256: change.before_text === null ? null : sha256Text(change.before_text),
            after_sha256: sha256Text(change.after_text)
        };
    });
    writeFileAtomically(path.join(backupPath, 'manifest.json'), `${JSON.stringify({
        schema_version: 1,
        event_source: 'review-catalog-management-backup',
        timestamp_utc: new Date().toISOString(),
        transaction_id: transactionId,
        plan_sha256: plan.plan_sha256,
        entries
    }, null, 2)}\n`, { encoding: 'utf8' });
    return backupPath;
}

function resolveActiveTaskAudit(repoRoot: string, bundleRoot: string): string[] {
    try {
        return [...resolveActiveTaskIds(repoRoot, bundleRoot, [], {
            includeAmbiguousRuntimeTasks: false,
            includeStaleRuntimeActiveTasks: false
        })].sort((left, right) => left.localeCompare(right));
    } catch {
        return [];
    }
}

function restoreChanges(bundleRoot: string, changes: readonly ReviewCatalogManagedFileChange[]): void {
    const failures: Error[] = [];
    for (const change of [...changes].reverse()) {
        try {
            assertManagedConfigDirectoryCurrent(bundleRoot);
            if (change.before_text === null) {
                if (!fs.existsSync(change.path)) continue;
                const identity = fs.lstatSync(change.path);
                if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
                    throw new Error(`Rollback refused an unsafe managed review config: ${change.path}`);
                }
                if (fs.readFileSync(change.path, 'utf8') !== change.after_text) {
                    throw new Error(`Rollback preserved an unowned concurrent managed review config: ${change.path}`);
                }
                fs.unlinkSync(change.path);
            } else {
                if (!fs.existsSync(change.path)) {
                    throw new Error(`Rollback preserved a concurrent deletion of managed review config: ${change.path}`);
                }
                const identity = fs.lstatSync(change.path);
                if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
                    throw new Error(`Rollback refused an unsafe managed review config: ${change.path}`);
                }
                const currentText = fs.readFileSync(change.path, 'utf8');
                if (currentText === change.before_text) continue;
                if (currentText !== change.after_text) {
                    throw new Error(`Rollback preserved an unowned concurrent managed review config: ${change.path}`);
                }
                writeFileAtomically(change.path, change.before_text, { encoding: 'utf8' });
            }
        } catch (error: unknown) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Review catalog transaction rollback failed.');
    }
}

function assertChangeBaselineCurrent(change: ReviewCatalogManagedFileChange): void {
    if (change.before_text === null) {
        if (fs.existsSync(change.path)) {
            throw new Error(`Managed review config appeared during publish: ${change.path}`);
        }
        return;
    }
    if (!fs.existsSync(change.path)) {
        throw new Error(`Managed review config disappeared during publish: ${change.path}`);
    }
    const identity = fs.lstatSync(change.path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
        throw new Error(`Managed review config changed to an unsafe file before publish: ${change.path}`);
    }
    if (fs.readFileSync(change.path, 'utf8') !== change.before_text) {
        throw new Error(`Managed review config drifted concurrently before publish: ${change.path}`);
    }
}

function writeAndVerifyChange(
    bundleRoot: string,
    change: ReviewCatalogManagedFileChange,
    writer: (filePath: string, content: string) => void
): void {
    assertManagedConfigDirectoryCurrent(bundleRoot);
    assertChangeBaselineCurrent(change);
    writer(change.path, change.after_text);
    assertManagedConfigDirectoryCurrent(bundleRoot);
    const identity = fs.lstatSync(change.path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
        throw new Error(`Managed review config changed to an unsafe file after publish: ${change.path}`);
    }
    const persisted = fs.readFileSync(change.path, 'utf8');
    if (sha256Text(persisted) !== sha256Text(change.after_text)) {
        throw new Error(`Managed review config atomic publish could not be verified: ${change.path}`);
    }
}

function buildAuditRecord(
    transactionId: string,
    transactionState: 'PREPARED' | 'COMMITTED' | 'ROLLED_BACK',
    plan: ReviewCatalogManagementPlan,
    backupPath: string | null,
    activeTaskIds: readonly string[],
    error?: unknown
): Record<string, unknown> {
    return {
        schema_version: 1,
        event_source: 'review-catalog-management',
        timestamp_utc: new Date().toISOString(),
        transaction_id: transactionId,
        transaction_state: transactionState,
        actor: 'operator_command',
        command: `review-catalog ${plan.operation} --apply`,
        operation: plan.operation,
        review_id: plan.review_id ?? null,
        plan_sha256: plan.plan_sha256,
        before_state_sha256: plan.before_state_sha256,
        after_state_sha256: plan.after_state_sha256,
        changed_files: plan.changes.map(({ relative_path }) => relative_path),
        backup_path: backupPath ? normalizeOutputPath(backupPath) : null,
        active_task_ids: activeTaskIds,
        affects_active_task_snapshots: false,
        affects_future_tasks_only: true,
        ...(error ? { error: (error instanceof Error ? error.message : String(error)).slice(0, 512) } : {})
    };
}

export function commitReviewCatalogManagementPlan(
    options: CommitReviewCatalogManagementPlanOptions
): ReviewCatalogTransactionResult {
    const expectedStateSha256 = normalizeSha256(options.expectedStateSha256, '--expected-state-sha256');
    const expectedPlanSha256 = normalizeSha256(options.expectedPlanSha256, '--expected-plan-sha256');
    if (expectedStateSha256 !== options.plan.before_state_sha256) {
        throw new Error('Expected state SHA-256 does not match the review-catalog preview baseline.');
    }
    if (expectedPlanSha256 !== options.plan.plan_sha256) {
        throw new Error('Expected plan SHA-256 does not match the review-catalog preview plan.');
    }
    assertManagedChanges(options.bundleRoot, options.plan.changes);
    const commitPlan = (): ReviewCatalogTransactionResult => {
        assertManagedConfigDirectoryCurrent(options.bundleRoot);
        const currentStateSha256 = options.readCurrentStateSha256();
        assertManagedConfigDirectoryCurrent(options.bundleRoot);
        if (currentStateSha256 !== expectedStateSha256) {
            throw new Error('Managed review configuration changed after preview; stale preview cannot be applied.');
        }
        requireOperatorOnlyContext(options.repoRoot, options.bundleRoot, 'Review catalog apply');
        consumeConfirmationReceipt(options.bundleRoot, options.plan, options.confirmationReceiptSha256);
        const transactionId = randomUUID();
        const auditPath = path.join(options.bundleRoot, 'runtime', 'review-catalog-management-audit.jsonl');
        const activeTaskIds = resolveActiveTaskAudit(options.repoRoot, options.bundleRoot);
        const backupPath = options.plan.changed
            ? createBackup(options.bundleRoot, transactionId, options.plan)
            : null;
        const preparedRecord = buildAuditRecord(
            transactionId,
            'PREPARED',
            options.plan,
            backupPath,
            activeTaskIds
        );
        appendAuditRecord(options.bundleRoot, auditPath, preparedRecord);
        if (options.plan.changed) {
            const writer = options.writeFile ?? ((filePath: string, content: string) => {
                writeFileAtomically(filePath, content, { encoding: 'utf8' });
            });
            try {
                for (const change of options.plan.changes) {
                    writeAndVerifyChange(options.bundleRoot, change, writer);
                }
                const afterStateSha256 = options.readCurrentStateSha256();
                if (afterStateSha256 !== options.plan.after_state_sha256) {
                    throw new Error('Managed review configuration drifted during atomic publish.');
                }
                const protectedManifestPath = writeProtectedControlPlaneManifest(options.repoRoot);
                appendAuditRecord(options.bundleRoot, auditPath, buildAuditRecord(
                    transactionId,
                    'COMMITTED',
                    options.plan,
                    backupPath,
                    activeTaskIds
                ));
                return {
                    status: 'APPLIED',
                    audit_path: normalizeOutputPath(auditPath),
                    backup_path: backupPath ? normalizeOutputPath(backupPath) : null,
                    protected_manifest_path: normalizeOutputPath(protectedManifestPath)
                };
            } catch (error: unknown) {
                try {
                    restoreChanges(options.bundleRoot, options.plan.changes);
                    writeProtectedControlPlaneManifest(options.repoRoot);
                    appendAuditRecord(options.bundleRoot, auditPath, buildAuditRecord(
                        transactionId,
                        'ROLLED_BACK',
                        options.plan,
                        backupPath,
                        activeTaskIds,
                        error
                    ));
                } catch (rollbackError: unknown) {
                    throw new AggregateError(
                        [error, rollbackError],
                        'Review catalog transaction failed and rollback could not be completed safely.'
                    );
                }
                throw new Error(
                    `Review catalog transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
        const protectedManifestPath = writeProtectedControlPlaneManifest(options.repoRoot);
        appendAuditRecord(options.bundleRoot, auditPath, buildAuditRecord(
            transactionId,
            'COMMITTED',
            options.plan,
            null,
            activeTaskIds
        ));
        return {
            status: 'NO_CHANGE',
            audit_path: normalizeOutputPath(auditPath),
            backup_path: null,
            protected_manifest_path: normalizeOutputPath(protectedManifestPath)
        };
    };
    return runWithTransactionLock(
        options.bundleRoot,
        'Review catalog transaction failed and its lock could not be released safely.',
        commitPlan
    );
}
