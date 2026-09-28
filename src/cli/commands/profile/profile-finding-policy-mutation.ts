import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstatFileIdentitySync } from '../../../core/file-stat';

import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../core/operator-confirmation';
import { resolveActiveTaskIds } from '../../../core/task-queue/active-task-state';
import { normalizePathValue } from '../cli-helpers';
import {
    assertProfileBundleRootOwnership,
    assertProfileBundleRootOwnershipCurrent,
    fsyncProfilesDirectoryBestEffort,
    getCompletedProfilesOperationResult,
    profileFileIdentityMatches,
    readProfilesData,
    resolveProfilesPath,
    type ProfileBundleRootOwnership,
    withProfilesDataLock,
    writeProfilesDataUnlocked
} from './profile-data';
import {
    buildProfileFindingPolicyPlan,
    hashProfilesData,
    type ProfileFindingPolicyMutationRequest,
    type ProfileFindingPolicyPlan
} from './profile-finding-policy';
import type { ParsedOptionsRecord, ProfilesData } from './profile-types';

const MAX_AUDIT_RECOVERY_BYTES = 256 * 1024;
const MAX_AUDIT_RECORD_BYTES = 2 * 1024;
const MAX_AUDIT_ERROR_CHARS = 256;

interface ExpectedMutationHashes {
    policy: string;
    plan: string;
    config: string;
}

interface LockedPolicyMutationOptions {
    ownership: ProfileBundleRootOwnership;
    bundleRoot: string;
    configPath: string;
    request: ProfileFindingPolicyMutationRequest;
    shippedData: ProfilesData | null;
    expectedHashes: ExpectedMutationHashes;
    activeTaskAudit: ReturnType<typeof resolveActiveTaskAudit>;
}

export interface ProfileFindingPolicyCommandPayload {
    action: 'profile_policy';
    mode: 'preview' | 'apply';
    status: 'PREVIEW' | 'APPLIED' | 'NO_CHANGE';
    operation: ProfileFindingPolicyPlan['operation'];
    target_profile: string;
    source_profile: string | null;
    policy: ProfileFindingPolicyPlan['policy'];
    policy_sha256: string;
    plan_sha256: string;
    before_policy_sha256: string;
    before_config_sha256: string;
    after_config_sha256: string;
    changed: boolean;
    migration: ProfileFindingPolicyPlan['migration'];
    diagnostics: string[];
    task_effect: {
        scope: 'future_tasks_only';
        active_task_snapshots_changed: false;
    };
    config_path: string;
    audit_path: string | null;
}

function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeSha256(value: unknown, flagName: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(normalized)) {
        throw new Error(`${flagName} must be a SHA-256 hex string from profile policy preview.`);
    }
    return normalized;
}

function readShippedProfiles(bundleRoot: string, ownership: ProfileBundleRootOwnership): ProfilesData | null {
    const shippedPath = path.join(bundleRoot, 'template', 'config', 'profiles.json');
    return fs.existsSync(shippedPath) ? readProfilesData(shippedPath, ownership) : null;
}

function requireMutationConfirmation(options: ParsedOptionsRecord): void {
    const confirmed = options.operatorConfirmed === undefined
        ? false
        : parseOperatorConfirmationYes(options.operatorConfirmed);
    validateFreshOperatorConfirmation({
        actionLabel: 'profile policy apply',
        confirmed,
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction:
            'Obtain explicit operator approval, then rerun with --operator-confirmed yes and ' +
            '--operator-confirmed-at-utc "<ISO-8601 timestamp>".'
    });
}

function resolveActiveTaskAudit(ownership: ProfileBundleRootOwnership): {
    active_task_discovery_status: 'resolved' | 'failed';
    active_task_discovery_error: string | null;
    active_task_count: number;
    active_task_ids_sha256: string;
} {
    assertProfileBundleRootOwnershipCurrent(ownership);
    try {
        const taskIds = [...resolveActiveTaskIds(ownership.repoRoot, ownership.bundleRoot, [], {
            includeAmbiguousRuntimeTasks: false,
            includeStaleRuntimeActiveTasks: false
        })].sort((left, right) => left.localeCompare(right));
        assertProfileBundleRootOwnershipCurrent(ownership);
        return {
            active_task_discovery_status: 'resolved',
            active_task_discovery_error: null,
            active_task_count: taskIds.length,
            active_task_ids_sha256: sha256Text(JSON.stringify(taskIds))
        };
    } catch (error: unknown) {
        assertProfileBundleRootOwnershipCurrent(ownership);
        return {
            active_task_discovery_status: 'failed',
            active_task_discovery_error: error instanceof Error ? error.name : 'UnknownError',
            active_task_count: 0,
            active_task_ids_sha256: sha256Text(JSON.stringify([]))
        };
    }
}

function resolveMutationAuditPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl');
}

function pathExistsWithoutFollowing(filePath: string): boolean {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

function assertAuditDirectoryBoundary(
    auditPath: string,
    ownership?: ProfileBundleRootOwnership
): void {
    const auditDirectory = path.dirname(auditPath);
    const bundleRoot = path.dirname(auditDirectory);
    const bundleIdentity = fs.lstatSync(bundleRoot);
    if (!bundleIdentity.isDirectory() || bundleIdentity.isSymbolicLink()) {
        throw new Error('Profile policy bundle root must remain a real directory.');
    }
    const directoryIdentity = fs.lstatSync(auditDirectory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
        throw new Error('Profile policy audit directory must be a real directory inside the bundle.');
    }
    if (ownership) {
        if (path.resolve(bundleRoot) !== path.resolve(ownership.bundleRoot)) {
            throw new Error('Profile policy audit path does not belong to the validated bundle.');
        }
        assertProfileBundleRootOwnershipCurrent(ownership);
    }
    const realBundleRoot = fs.realpathSync.native(bundleRoot);
    const realAuditDirectory = fs.realpathSync.native(auditDirectory);
    const expectedAuditDirectory = path.join(realBundleRoot, path.basename(auditDirectory));
    if (path.resolve(realAuditDirectory) !== path.resolve(expectedAuditDirectory)) {
        throw new Error('Profile policy audit directory resolves outside the bundle.');
    }
}

function assertOpenedAuditIdentity(
    auditPath: string,
    fd: number,
    ownership?: ProfileBundleRootOwnership
): void {
    const openedIdentity = fs.fstatSync(fd);
    const pathIdentity = lstatFileIdentitySync(auditPath);
    if (!openedIdentity.isFile() || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()) {
        throw new Error('Profile policy audit must be a regular file.');
    }
    if (openedIdentity.nlink !== 1 || pathIdentity.nlink !== 1) {
        throw new Error('Profile policy audit must not have additional hard links.');
    }
    if (!profileFileIdentityMatches(openedIdentity, pathIdentity)) {
        throw new Error('Profile policy audit path changed while it was opened.');
    }
    assertAuditDirectoryBoundary(auditPath, ownership);
}

function openAuditFileSecurely(
    auditPath: string,
    flags: number,
    ownership?: ProfileBundleRootOwnership
): number {
    assertAuditDirectoryBoundary(auditPath, ownership);
    const fd = fs.openSync(auditPath, flags | fs.constants.O_NOFOLLOW, 0o600);
    try {
        assertOpenedAuditIdentity(auditPath, fd, ownership);
        return fd;
    } catch (error: unknown) {
        fs.closeSync(fd);
        throw error;
    }
}

function appendAuditRecordDurably(
    auditPath: string,
    record: Record<string, unknown>,
    ownership?: ProfileBundleRootOwnership
): void {
    const auditDirectory = path.dirname(auditPath);
    if (ownership) assertProfileBundleRootOwnershipCurrent(ownership);
    const auditFileExisted = pathExistsWithoutFollowing(auditPath);
    fs.mkdirSync(auditDirectory, { recursive: true });
    const fd = openAuditFileSecurely(
        auditPath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
        ownership
    );
    let persisted = false;
    try {
        const serializedRecord = `${JSON.stringify(record)}\n`;
        assertAuditRecordFits(serializedRecord);
        fs.writeFileSync(fd, serializedRecord, 'utf8');
        fs.fsyncSync(fd);
        persisted = true;
    } finally {
        fs.closeSync(fd);
    }
    if (persisted && !auditFileExisted) fsyncProfilesDirectoryBestEffort(auditDirectory);
}

function assertAuditRecordFits(serializedRecord: string): void {
    if (Buffer.byteLength(serializedRecord, 'utf8') > MAX_AUDIT_RECORD_BYTES) {
        throw new Error(`Profile policy audit record exceeds ${MAX_AUDIT_RECORD_BYTES} bytes.`);
    }
}

function readRecoverableAuditRecords(
    auditPath: string,
    ownership?: ProfileBundleRootOwnership
): Array<Record<string, unknown>> {
    if (ownership) assertProfileBundleRootOwnershipCurrent(ownership);
    if (!pathExistsWithoutFollowing(auditPath)) return [];
    const fd = openAuditFileSecurely(auditPath, fs.constants.O_RDWR, ownership);
    try {
        const size = fs.fstatSync(fd).size;
        const readStart = Math.max(0, size - MAX_AUDIT_RECOVERY_BYTES);
        const tail = Buffer.alloc(size - readStart);
        if (tail.length > 0) fs.readSync(fd, tail, 0, tail.length, readStart);

        let windowOffset = 0;
        if (readStart > 0) {
            const firstLineEnd = tail.indexOf(0x0a);
            if (firstLineEnd < 0) {
                throw new Error(`Profile policy audit record exceeds ${MAX_AUDIT_RECOVERY_BYTES} recovery bytes.`);
            }
            windowOffset = firstLineEnd + 1;
        }

        const records: Array<Record<string, unknown>> = [];
        let lineStart = windowOffset;
        while (lineStart < tail.length) {
            const lineEnd = tail.indexOf(0x0a, lineStart);
            const terminalLine = lineEnd < 0;
            const end = terminalLine ? tail.length : lineEnd;
            const line = tail.subarray(lineStart, end).toString('utf8').trim();
            if (line) {
                try {
                    records.push(JSON.parse(line) as Record<string, unknown>);
                    if (terminalLine) {
                        fs.writeSync(fd, '\n', size, 'utf8');
                        fs.fsyncSync(fd);
                    }
                } catch (error: unknown) {
                    if (!terminalLine) {
                        throw new Error(`Profile policy audit contains invalid non-terminal JSON: ${getErrorMessage(error)}`);
                    }
                    fs.ftruncateSync(fd, readStart + lineStart);
                    fs.fsyncSync(fd);
                }
            }
            if (terminalLine) break;
            lineStart = lineEnd + 1;
        }
        return records;
    } finally {
        fs.closeSync(fd);
    }
}

function recoverPendingMutationAudits(
    auditPath: string,
    currentConfigSha256: string,
    ownership?: ProfileBundleRootOwnership
): void {
    const latestByTransaction = new Map<string, Record<string, unknown>>();
    for (const record of readRecoverableAuditRecords(auditPath, ownership)) {
        if (record.event_source !== 'profile-finding-policy-mutation') continue;
        const transactionId = String(record.transaction_id || '').trim();
        if (transactionId) latestByTransaction.set(transactionId, record);
    }
    for (const [transactionId, record] of latestByTransaction.entries()) {
        if (record.transaction_state !== 'PREPARED') continue;
        const beforeSha256 = String(record.before_config_sha256 || '');
        const afterSha256 = String(record.after_config_sha256 || '');
        let transactionState: 'COMMITTED' | 'ABORTED';
        if (currentConfigSha256 === afterSha256) {
            transactionState = 'COMMITTED';
        } else if (currentConfigSha256 === beforeSha256) {
            transactionState = 'ABORTED';
        } else {
            throw new Error(`Cannot recover profile policy audit transaction '${transactionId}': config hash diverged.`);
        }
        appendAuditRecordDurably(auditPath, {
            ...record,
            timestamp_utc: new Date().toISOString(),
            transaction_state: transactionState,
            status: transactionState === 'COMMITTED' ? record.intended_status : 'ABORTED',
            recovered: true
        }, ownership);
    }
}

export function recoverPendingProfileFindingPolicyAudits(
    bundleRoot: string,
    currentData: ProfilesData,
    ownership?: ProfileBundleRootOwnership
): void {
    recoverPendingMutationAudits(resolveMutationAuditPath(bundleRoot), hashProfilesData(currentData), ownership);
}

function buildMutationAuditRecord(
    configPath: string,
    plan: ProfileFindingPolicyPlan,
    status: 'APPLIED' | 'NO_CHANGE',
    activeTaskAudit: ReturnType<typeof resolveActiveTaskAudit>
): Record<string, unknown> {
    return {
        schema_version: 1,
        event_source: 'profile-finding-policy-mutation',
        timestamp_utc: new Date().toISOString(),
        transaction_id: randomUUID(),
        transaction_state: status === 'NO_CHANGE' ? 'COMMITTED' : 'PREPARED',
        intended_status: status,
        actor: 'operator_command',
        command: 'profile policy apply',
        status: status === 'NO_CHANGE' ? status : 'PREPARED',
        operation: plan.operation,
        target_profile: plan.target_profile,
        source_profile: plan.source_profile,
        config_path: normalizePathValue(configPath).replace(/\\/gu, '/'),
        policy_sha256: plan.policy_sha256,
        plan_sha256: plan.plan_sha256,
        before_policy_sha256: plan.before_policy_sha256,
        before_config_sha256: plan.before_config_sha256,
        after_config_sha256: plan.after_config_sha256,
        changed: plan.changed,
        affects_active_task_snapshots: false,
        affects_future_tasks_only: true,
        ...activeTaskAudit
    };
}

function buildPayload(
    plan: ProfileFindingPolicyPlan,
    mode: 'preview' | 'apply',
    status: ProfileFindingPolicyCommandPayload['status'],
    configPath: string,
    auditPath: string | null
): ProfileFindingPolicyCommandPayload {
    const migration = mode === 'apply'
        ? {
            required: false,
            reason: 'Persisted review_finding_policy is current.',
            target_policy_id: plan.policy.policy_id
        }
        : plan.migration;
    return {
        action: 'profile_policy',
        mode,
        status,
        operation: plan.operation,
        target_profile: plan.target_profile,
        source_profile: plan.source_profile,
        policy: plan.policy,
        policy_sha256: plan.policy_sha256,
        plan_sha256: plan.plan_sha256,
        before_policy_sha256: plan.before_policy_sha256,
        before_config_sha256: plan.before_config_sha256,
        after_config_sha256: plan.after_config_sha256,
        changed: plan.changed,
        migration,
        diagnostics: plan.diagnostics,
        task_effect: {
            scope: 'future_tasks_only',
            active_task_snapshots_changed: false
        },
        config_path: normalizePathValue(configPath).replace(/\\/gu, '/'),
        audit_path: auditPath
    };
}

function requestFromOptions(targetProfile: string, options: ParsedOptionsRecord): ProfileFindingPolicyMutationRequest {
    return {
        targetProfile,
        preset: typeof options.preset === 'string' ? options.preset : undefined,
        copyFrom: typeof options.copyFrom === 'string' ? options.copyFrom : undefined,
        reset: options.reset === true,
        critical: typeof options.critical === 'string' ? options.critical : undefined,
        high: typeof options.high === 'string' ? options.high : undefined,
        medium: typeof options.medium === 'string' ? options.medium : undefined,
        low: typeof options.low === 'string' ? options.low : undefined,
        residualRisk: typeof options.residualRisk === 'string' ? options.residualRisk : undefined
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getBoundedAuditErrorMessage(error: unknown): string {
    const message = getErrorMessage(error);
    return message.length <= MAX_AUDIT_ERROR_CHARS
        ? message
        : `${message.slice(0, MAX_AUDIT_ERROR_CHARS - 1)}…`;
}

type ApplyPlanWithAuditOptions = {
    ownership: ProfileBundleRootOwnership;
    bundleRoot: string;
    configPath: string;
    plan: ProfileFindingPolicyPlan;
    activeTaskAudit: ReturnType<typeof resolveActiveTaskAudit>;
};

type ApplyPlanStatus = 'APPLIED' | 'NO_CHANGE';

function prepareMutationAudit(
    auditPath: string,
    record: Record<string, unknown>,
    status: ApplyPlanStatus,
    ownership: ProfileBundleRootOwnership
): void {
    try {
        if (record.transaction_state === 'PREPARED') assertTerminalAuditRecordsFit(record, status);
        appendAuditRecordDurably(auditPath, record, ownership);
    } catch (error: unknown) {
        throw new Error(`Profile policy audit preparation failed: ${getErrorMessage(error)}`);
    }
}

function assertTerminalAuditRecordsFit(record: Record<string, unknown>, status: ApplyPlanStatus): void {
    const timestamp_utc = new Date().toISOString();
    const candidates: Array<Record<string, unknown>> = [
        { ...record, timestamp_utc, transaction_state: 'COMMITTED', status },
        { ...record, timestamp_utc, transaction_state: 'COMMITTED', status, recovered: true },
        { ...record, timestamp_utc, transaction_state: 'ABORTED', status: 'ABORTED', recovered: true },
        {
            ...record,
            timestamp_utc,
            transaction_state: 'COMMITTED',
            status,
            committed_after_write_error: true,
            write_error: '界'.repeat(MAX_AUDIT_ERROR_CHARS)
        }
    ];
    for (const candidate of candidates) assertAuditRecordFits(`${JSON.stringify(candidate)}\n`);
}

function inspectConfigAfterWriteFailure(
    configPath: string,
    configError: unknown,
    ownership: ProfileBundleRootOwnership
): string {
    try {
        return hashProfilesData(readProfilesData(configPath, ownership));
    } catch (inspectionError: unknown) {
        throw new Error(
            `Profile policy config write failed and the resulting config could not be inspected; ` +
            `audit remains PREPARED for recovery: ${getErrorMessage(configError)}; ` +
            `inspection failed: ${getErrorMessage(inspectionError)}`
        );
    }
}

function handleConfigWriteFailure(options: {
    apply: ApplyPlanWithAuditOptions;
    auditPath: string;
    record: Record<string, unknown>;
    status: ApplyPlanStatus;
    configError: unknown;
}): never {
    const observedConfigSha256 = inspectConfigAfterWriteFailure(
        options.apply.configPath,
        options.configError,
        options.apply.ownership
    );
    if (observedConfigSha256 === options.apply.plan.after_config_sha256) {
        appendAuditRecordDurably(options.auditPath, {
            ...options.record,
            timestamp_utc: new Date().toISOString(),
            transaction_state: 'COMMITTED',
            status: options.status,
            committed_after_write_error: true,
            write_error: getBoundedAuditErrorMessage(options.configError)
        }, options.apply.ownership);
        throw new Error(
            `Profile policy config committed but write finalization reported an error: ${getErrorMessage(options.configError)}`
        );
    }
    if (observedConfigSha256 === options.apply.plan.before_config_sha256) {
        appendAuditRecordDurably(options.auditPath, {
            ...options.record,
            timestamp_utc: new Date().toISOString(),
            transaction_state: 'ABORTED',
            status: 'ABORTED'
        }, options.apply.ownership);
        throw options.configError;
    }
    throw new Error(
        `Profile policy config write failed with a divergent config; audit remains PREPARED for recovery: ` +
        getErrorMessage(options.configError)
    );
}

function finalizeCommittedAudit(
    auditPath: string,
    record: Record<string, unknown>,
    status: ApplyPlanStatus,
    ownership: ProfileBundleRootOwnership
): void {
    try {
        appendAuditRecordDurably(auditPath, {
            ...record,
            timestamp_utc: new Date().toISOString(),
            transaction_state: 'COMMITTED',
            status
        }, ownership);
    } catch (auditError: unknown) {
        throw new Error(
            `Profile policy config committed but audit finalization failed; rerun apply to recover: ` +
            getErrorMessage(auditError)
        );
    }
}

function applyPlanWithAudit(options: ApplyPlanWithAuditOptions): { status: ApplyPlanStatus; auditPath: string } {
    const status = options.plan.changed ? 'APPLIED' : 'NO_CHANGE';
    const auditPath = resolveMutationAuditPath(options.bundleRoot);
    const record = buildMutationAuditRecord(
        options.configPath,
        options.plan,
        status,
        options.activeTaskAudit
    );
    prepareMutationAudit(auditPath, record, status, options.ownership);
    if (!options.plan.changed) {
        return { status, auditPath: normalizePathValue(auditPath).replace(/\\/gu, '/') };
    }
    try {
        writeProfilesDataUnlocked(
            options.configPath,
            options.plan.proposed_data,
            options.ownership,
            options.plan.before_config_sha256
        );
    } catch (configError: unknown) {
        handleConfigWriteFailure({ apply: options, auditPath, record, status, configError });
    }
    finalizeCommittedAudit(auditPath, record, status, options.ownership);
    return { status, auditPath: normalizePathValue(auditPath).replace(/\\/gu, '/') };
}

function readExpectedMutationHashes(options: ParsedOptionsRecord): ExpectedMutationHashes {
    return {
        policy: normalizeSha256(options.expectedPolicySha256, '--expected-policy-sha256'),
        plan: normalizeSha256(options.expectedPlanSha256, '--expected-plan-sha256'),
        config: normalizeSha256(options.expectedConfigSha256, '--expected-config-sha256')
    };
}

function assertCurrentPlanMatchesPreview(
    plan: ProfileFindingPolicyPlan,
    expected: ExpectedMutationHashes
): void {
    if (expected.config !== plan.before_config_sha256) {
        throw new Error('Profiles config changed after preview; stale preview cannot be applied.');
    }
    if (expected.policy !== plan.policy_sha256) {
        throw new Error('Policy input changed after preview; rerun profile policy preview and use its policy SHA-256.');
    }
    if (expected.plan !== plan.plan_sha256) {
        throw new Error('Policy plan changed after preview; rerun profile policy preview and use its plan SHA-256.');
    }
}

function runLockedPolicyMutation(options: LockedPolicyMutationOptions): ProfileFindingPolicyCommandPayload {
    try {
        return withProfilesDataLock(options.configPath, () => {
            const currentData = readProfilesData(options.configPath, options.ownership);
            try {
                recoverPendingProfileFindingPolicyAudits(options.bundleRoot, currentData, options.ownership);
            } catch (error: unknown) {
                throw new Error(`Profile policy audit recovery failed: ${getErrorMessage(error)}`);
            }
            const plan = buildProfileFindingPolicyPlan(currentData, options.request, options.shippedData);
            assertCurrentPlanMatchesPreview(plan, options.expectedHashes);
            const result = applyPlanWithAudit({
                ownership: options.ownership,
                bundleRoot: options.bundleRoot,
                configPath: options.configPath,
                plan,
                activeTaskAudit: options.activeTaskAudit
            });
            return buildPayload(plan, 'apply', result.status, options.configPath, result.auditPath);
        }, options.ownership);
    } catch (error: unknown) {
        const completed = getCompletedProfilesOperationResult<ProfileFindingPolicyCommandPayload>(error);
        if (!completed) throw error;
        const completionDescription = completed.result.status === 'NO_CHANGE'
            ? 'Profile policy no-change audit committed'
            : 'Profiles config committed';
        return {
            ...completed.result,
            diagnostics: [
                ...completed.result.diagnostics,
                `${completionDescription}, but lock release failed: ${getErrorMessage(error)}`
            ]
        };
    }
}

export function runProfileFindingPolicyCommand(options: {
    mode: 'preview' | 'apply';
    targetProfile: string;
    parsedOptions: ParsedOptionsRecord;
    repoRoot: string;
    bundleRoot: string;
}): ProfileFindingPolicyCommandPayload {
    const ownedRoots = assertProfileBundleRootOwnership(options.repoRoot, options.bundleRoot);
    const configPath = resolveProfilesPath(ownedRoots.bundleRoot);
    const request = requestFromOptions(options.targetProfile, options.parsedOptions);
    const shippedData = request.reset ? readShippedProfiles(ownedRoots.bundleRoot, ownedRoots) : null;
    const plan = buildProfileFindingPolicyPlan(readProfilesData(configPath, ownedRoots), request, shippedData);
    if (options.mode === 'preview') {
        return buildPayload(plan, 'preview', 'PREVIEW', configPath, null);
    }
    if (plan.operation === 'inspect') {
        throw new Error('profile policy apply requires --preset, --copy-from, --reset, or a legacy profile migration.');
    }
    requireMutationConfirmation(options.parsedOptions);
    return runLockedPolicyMutation({
        ownership: ownedRoots,
        bundleRoot: ownedRoots.bundleRoot,
        configPath,
        request,
        shippedData,
        expectedHashes: readExpectedMutationHashes(options.parsedOptions),
        activeTaskAudit: resolveActiveTaskAudit(ownedRoots)
    });
}

export function formatProfileFindingPolicyCommandOutput(
    payload: ProfileFindingPolicyCommandPayload,
    jsonMode: boolean
): string {
    if (jsonMode) {
        return JSON.stringify(payload, null, 2);
    }
    return [
        'GARDA_PROFILE_POLICY',
        `Mode: ${payload.mode}`,
        `Status: ${payload.status}`,
        `Operation: ${payload.operation}`,
        `TargetProfile: ${payload.target_profile}`,
        `SourceProfile: ${payload.source_profile || 'none'}`,
        `PolicyId: ${payload.policy.policy_id}`,
        `PolicySha256: ${payload.policy_sha256}`,
        `PlanSha256: ${payload.plan_sha256}`,
        `BeforeConfigSha256: ${payload.before_config_sha256}`,
        `AfterConfigSha256: ${payload.after_config_sha256}`,
        `Changed: ${payload.changed}`,
        `MigrationRequired: ${payload.migration.required}`,
        `MigrationReason: ${payload.migration.reason || 'none'}`,
        `Diagnostics: ${payload.diagnostics.length > 0 ? payload.diagnostics.join(' | ') : 'none'}`,
        'TaskEffect: future_tasks_only; active_task_snapshots_changed=false',
        `ConfigPath: ${payload.config_path}`,
        `AuditPath: ${payload.audit_path || 'none'}`
    ].join('\n');
}
