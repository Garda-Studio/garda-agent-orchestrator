import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactJsonFile,
    withReviewArtifactReadBarrier
} from '../../gate-runtime/review-artifacts';
import {
    isPathRealpathInsideRoot,
    normalizePath,
    toPlainRecord
} from '../shared/helpers';
import {
    buildReviewFindingsDispositionArtifact,
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath,
    type ReviewFindingsDispositionArtifact
} from './review-findings-disposition-artifact';
import {
    getReviewFindingsFollowUpTasksArtifactPath,
    REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION,
    REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE
} from './review-findings-follow-up-tasks';
import type { LockedReviewFindingPolicyResolution } from './review-finding-disposition';
import type { ReviewFindingsValidationArtifact } from './review-findings-validation-artifact';

interface ReviewFindingsDispositionReceiptReference {
    artifact_path: string;
    artifact_sha256: string;
    snapshot_path: string | null;
    snapshot_sha256: string | null;
    disposition_result_sha256: string;
    policy_id: string;
    policy_source: string;
    item_count: number;
    fix_now_count: number;
    follow_up_pending_count: number;
    ignored_count: number;
    blocking_count: number;
}

export interface ReviewFindingsDispositionEvidenceCheckResult {
    valid: boolean;
    artifact: ReviewFindingsDispositionArtifact | null;
    artifact_sha256: string | null;
    follow_up_artifact_path: string | null;
    violations: string[];
}

export interface ReviewFindingsDispositionEvidenceCheckOptions {
    repoRoot: string;
    receipt: Record<string, unknown>;
    receiptPath: string;
    reviewArtifactPath: string;
    expectedTaskId: string;
    expectedReviewType: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    policyResolution: LockedReviewFindingPolicyResolution;
    expectedReceiptPath?: string | null;
    expectedReceiptSha256?: string | null;
    preferSnapshot?: boolean;
    taskQueueRows?: readonly {
        taskId: string;
        notes?: string | null;
    }[];
}

export interface ReviewFindingsTaskQueueRow {
    taskId: string;
    notes?: string | null;
}

export function resolveReviewFindingsTaskQueueRows(options: {
    repoRoot: string;
    taskQueueRows?: readonly ReviewFindingsTaskQueueRow[];
}): ReviewFindingsTaskQueueRow[] {
    if (options.taskQueueRows !== undefined) {
        return [...options.taskQueueRows];
    }
    const taskPath = path.join(options.repoRoot, TASK_QUEUE_FILENAME);
    return fs.existsSync(taskPath)
        ? parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8')).rows
        : [];
}

function normalizeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function normalizeNonEmptyPath(value: unknown): string | null {
    const normalized = normalizePath(value);
    return normalized || null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function normalizeDispositionReference(value: unknown): ReviewFindingsDispositionReceiptReference | null {
    const reference = toPlainRecord(value);
    if (!reference) {
        return null;
    }
    const artifactPath = normalizeNonEmptyPath(reference.artifact_path);
    const artifactSha256 = normalizeHash(reference.artifact_sha256);
    const snapshotPath = normalizeNonEmptyPath(reference.snapshot_path);
    const snapshotSha256 = normalizeHash(reference.snapshot_sha256);
    const dispositionResultSha256 = normalizeHash(reference.disposition_result_sha256);
    const policyId = String(reference.policy_id || '').trim();
    const policySource = String(reference.policy_source || '').trim();
    const itemCount = normalizeNonNegativeInteger(reference.item_count);
    const fixNowCount = normalizeNonNegativeInteger(reference.fix_now_count);
    const followUpPendingCount = normalizeNonNegativeInteger(reference.follow_up_pending_count);
    const ignoredCount = normalizeNonNegativeInteger(reference.ignored_count);
    const blockingCount = normalizeNonNegativeInteger(reference.blocking_count);
    if (
        !artifactPath
        || !artifactSha256
        || !snapshotPath
        || !snapshotSha256
        || !dispositionResultSha256
        || !policyId
        || !policySource
        || itemCount === null
        || fixNowCount === null
        || followUpPendingCount === null
        || ignoredCount === null
        || blockingCount === null
    ) {
        return null;
    }
    return {
        artifact_path: artifactPath,
        artifact_sha256: artifactSha256,
        snapshot_path: snapshotPath,
        snapshot_sha256: snapshotSha256,
        disposition_result_sha256: dispositionResultSha256,
        policy_id: policyId,
        policy_source: policySource,
        item_count: itemCount,
        fix_now_count: fixNowCount,
        follow_up_pending_count: followUpPendingCount,
        ignored_count: ignoredCount,
        blocking_count: blockingCount
    };
}

function readJsonRecord(filePath: string, subject: string, violations: string[]): Record<string, unknown> | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        violations.push(`${subject} '${normalizePath(filePath)}' is missing.`);
        return null;
    }
    try {
        return toPlainRecord(readReviewArtifactJsonFile(filePath));
    } catch {
        violations.push(`${subject} '${normalizePath(filePath)}' is not valid JSON.`);
        return null;
    }
}

function assertEqual(
    violations: string[],
    subject: string,
    actual: unknown,
    expected: unknown
): void {
    if (actual !== expected) {
        violations.push(`${subject} mismatch: expected ${String(expected)}, found ${String(actual ?? 'missing')}.`);
    }
}

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function buildExpectedFollowUpFingerprint(options: {
    taskId: string;
    reviewType: string;
    item: ReviewFindingsDispositionArtifact['items'][number];
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
}): string {
    const payload = {
        schema_version: 1,
        parent_task_id: options.taskId,
        review_type: options.reviewType,
        item_id: options.item.id,
        item_kind: options.item.kind,
        severity: options.item.severity,
        action: options.item.action,
        source_rule: options.item.source_rule,
        validation_artifact_sha256: options.validationArtifactSha256,
        validation_result_sha256: options.validationResultSha256,
        disposition_artifact_sha256: options.dispositionArtifactSha256,
        disposition_result_sha256: options.dispositionResultSha256
    };
    return sha256JsonPayload(payload);
}

function isParentFollowUpTaskId(parentTaskId: string, taskId: string): boolean {
    const prefix = `${parentTaskId}-F`;
    return taskId.startsWith(prefix) && /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

function validateFollowUpSatisfaction(options: {
    repoRoot: string;
    receiptPath: string;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string;
    dispositionArtifact: ReviewFindingsDispositionArtifact;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    taskId: string;
    reviewType: string;
    expectedReceiptPath?: string | null;
    expectedReceiptSha256?: string | null;
    taskQueueRows?: readonly {
        taskId: string;
        notes?: string | null;
    }[];
}): { artifactPath: string | null; violations: string[] } {
    const followUpCount = options.dispositionArtifact.summary.follow_up_pending_count;
    if (followUpCount === 0) {
        return { artifactPath: null, violations: [] };
    }
    const violations: string[] = [];
    const artifactPath = getReviewFindingsFollowUpTasksArtifactPath(options.dispositionArtifactPath);
    if (!isPathRealpathInsideRoot(artifactPath, options.repoRoot, { allowMissing: true })) {
        violations.push(
            `Review findings follow-up artifact path must resolve inside repo root without symlink or junction escape: ` +
            `${normalizePath(artifactPath)}.`
        );
        return { artifactPath, violations };
    }
    const artifact = readJsonRecord(artifactPath, 'Review findings follow-up artifact', violations);
    if (!artifact) {
        return { artifactPath, violations };
    }
    assertEqual(violations, 'Review findings follow-up artifact schema_version', artifact.schema_version, REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION);
    assertEqual(violations, 'Review findings follow-up artifact artifact_type', artifact.artifact_type, REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE);
    assertEqual(violations, 'Review findings follow-up artifact task_id', artifact.task_id, options.taskId);
    assertEqual(violations, 'Review findings follow-up artifact review_type', artifact.review_type, options.reviewType);
    if (artifact.status !== 'MATERIALIZED' && artifact.status !== 'ALREADY_MATERIALIZED') {
        violations.push(
            `Review findings follow-up artifact status must be MATERIALIZED or ALREADY_MATERIALIZED; ` +
            `found ${String(artifact.status || 'missing')}.`
        );
    }
    if (!Array.isArray(artifact.violations)) {
        violations.push('Review findings follow-up artifact violations must be an array.');
    } else if (artifact.violations.length > 0) {
        violations.push('Review findings follow-up artifact contains unresolved materialization violations.');
    }
    const sourceDisposition = toPlainRecord(artifact.source_disposition);
    assertEqual(violations, 'Review findings follow-up source disposition path', normalizeNonEmptyPath(sourceDisposition?.artifact_path), normalizePath(options.dispositionArtifactPath));
    assertEqual(violations, 'Review findings follow-up source disposition sha256', normalizeHash(sourceDisposition?.artifact_sha256), options.dispositionArtifactSha256);
    assertEqual(violations, 'Review findings follow-up source disposition result sha256', normalizeHash(sourceDisposition?.disposition_result_sha256), options.dispositionArtifact.disposition_result_sha256);
    const sourceValidation = toPlainRecord(artifact.source_validation);
    assertEqual(violations, 'Review findings follow-up source validation path', normalizeNonEmptyPath(sourceValidation?.artifact_path), normalizePath(options.validationArtifactPath));
    assertEqual(violations, 'Review findings follow-up source validation sha256', normalizeHash(sourceValidation?.artifact_sha256), options.validationArtifactSha256);
    assertEqual(violations, 'Review findings follow-up source validation result sha256', normalizeHash(sourceValidation?.validation_result_sha256), options.validationArtifact.validation_result_sha256);
    assertEqual(violations, 'Review findings follow-up source validation status', sourceValidation?.status, 'accepted');
    assertEqual(violations, 'Review findings follow-up source validation accepted', sourceValidation?.accepted, true);
    const sourceReceipt = toPlainRecord(artifact.source_receipt);
    const expectedReceiptPath = normalizePath(options.expectedReceiptPath || options.receiptPath);
    const expectedReceiptSha256 = normalizeHash(options.expectedReceiptSha256)
        || readReviewArtifactFileSha256(options.receiptPath);
    assertEqual(violations, 'Review findings follow-up source receipt path', normalizeNonEmptyPath(sourceReceipt?.receipt_path), expectedReceiptPath);
    assertEqual(violations, 'Review findings follow-up source receipt sha256', normalizeHash(sourceReceipt?.receipt_sha256), expectedReceiptSha256);
    const summary = toPlainRecord(artifact.summary);
    assertEqual(violations, 'Review findings follow-up obligation count', normalizeNonNegativeInteger(summary?.follow_up_obligation_count), followUpCount);
    assertEqual(violations, 'Review findings follow-up blocked task count', normalizeNonNegativeInteger(summary?.blocked_task_count), 0);
    const items = Array.isArray(artifact.items) ? artifact.items.map((item) => toPlainRecord(item)).filter(Boolean) : [];
    const materializedItems = items.filter((item) => (
        item?.action === 'create_follow_up'
        && (item.materialization_status === 'created' || item.materialization_status === 'already_materialized')
        && typeof item.task_id === 'string'
        && item.task_id.trim().length > 0
    ));
    assertEqual(violations, 'Review findings follow-up materialized item count', materializedItems.length, followUpCount);
    const materializedByFingerprint = new Map<string, Record<string, unknown>[]>();
    for (const item of materializedItems) {
        const fingerprint = normalizeHash(item?.fingerprint);
        if (!fingerprint) {
            violations.push('Review findings follow-up materialized item is missing a valid fingerprint.');
            continue;
        }
        const matches = materializedByFingerprint.get(fingerprint) || [];
        matches.push(item as Record<string, unknown>);
        materializedByFingerprint.set(fingerprint, matches);
    }
    const expectedItems = options.dispositionArtifact.items.filter((item) => item.action === 'create_follow_up');
    const expectedFingerprints: string[] = [];
    for (const expectedItem of expectedItems) {
        const expectedFingerprint = buildExpectedFollowUpFingerprint({
            taskId: options.taskId,
            reviewType: options.reviewType,
            item: expectedItem,
            validationArtifactSha256: options.validationArtifactSha256,
            validationResultSha256: options.validationArtifact.validation_result_sha256,
            dispositionArtifactSha256: options.dispositionArtifactSha256,
            dispositionResultSha256: options.dispositionArtifact.disposition_result_sha256
        });
        expectedFingerprints.push(expectedFingerprint);
        const matches = materializedByFingerprint.get(expectedFingerprint) || [];
        if (matches.length !== 1) {
            violations.push(
                `Review findings follow-up disposition item '${expectedItem.kind}:${expectedItem.id}' must have exactly one ` +
                `materialized item bound by fingerprint; found ${matches.length}.`
            );
            continue;
        }
        const materializedItem = matches[0];
        assertEqual(violations, 'Review findings follow-up source item id', materializedItem.source_item_id, expectedItem.id);
        assertEqual(violations, 'Review findings follow-up source item kind', materializedItem.source_item_kind, expectedItem.kind);
        assertEqual(violations, 'Review findings follow-up source item severity', materializedItem.severity, expectedItem.severity);
        assertEqual(violations, 'Review findings follow-up source item action', materializedItem.action, expectedItem.action);
        assertEqual(violations, 'Review findings follow-up source item rule', materializedItem.source_rule, expectedItem.source_rule);
        assertEqual(violations, 'Review findings follow-up source item policy', materializedItem.source_policy, expectedItem.policy_source);
        assertEqual(violations, 'Review findings follow-up source item blocking', materializedItem.blocking, expectedItem.blocking);
    }
    const taskRows = resolveReviewFindingsTaskQueueRows(options);
    const taskRowsById = new Map(taskRows.map((row) => [row.taskId, row]));
    const materializationPolicy = toPlainRecord(artifact.materialization_policy);
    const materializationMode = materializationPolicy?.mode;
    const groupFingerprint = normalizeHash(materializationPolicy?.group_fingerprint);
    const groupedLaneBindingPrefix = materializationMode === 'grouped_by_parent'
        ? `review_follow_up_lane_binding=${options.reviewType}:${expectedFingerprints.length}:` +
            `${sha256JsonPayload([...expectedFingerprints].sort())}:`
        : null;
    for (const item of materializedItems) {
        const taskId = String(item?.task_id || '').trim();
        if (!isParentFollowUpTaskId(options.taskId, taskId)) {
            violations.push(
                `Review findings follow-up materialized task '${taskId || 'missing'}' is not a child of '${options.taskId}'.`
            );
            continue;
        }
        const taskRow = taskRowsById.get(taskId);
        if (!taskRow) {
            violations.push(`Review findings follow-up materialized task '${taskId}' does not resolve in TASK.md.`);
            continue;
        }
        const taskNotes = taskRow.notes || '';
        const fingerprint = normalizeHash(item?.fingerprint);
        if (materializationMode === 'grouped_by_parent') {
            if (
                !groupFingerprint
                || !taskNotes.includes(`review_follow_up_group_fingerprint=${groupFingerprint}`)
                || !groupedLaneBindingPrefix
                || !taskNotes.includes(groupedLaneBindingPrefix)
            ) {
                violations.push(
                    `Review findings follow-up materialized task '${taskId}' is not bound to the expected grouped disposition lane.`
                );
            }
        } else if (!fingerprint || !taskNotes.includes(`review_follow_up_fingerprint=${fingerprint}`)) {
            violations.push(
                `Review findings follow-up materialized task '${taskId}' is not bound to fingerprint '${fingerprint || 'missing'}'.`
            );
        }
    }
    return { artifactPath, violations };
}

function validateReviewFindingsDispositionEvidenceUnlocked(
    options: ReviewFindingsDispositionEvidenceCheckOptions
): ReviewFindingsDispositionEvidenceCheckResult {
    const violations: string[] = [];
    const reference = normalizeDispositionReference(options.receipt.review_findings_disposition_artifact);
    if (!reference) {
        return {
            valid: false,
            artifact: null,
            artifact_sha256: null,
            follow_up_artifact_path: null,
            violations: ['Review receipt is missing complete review_findings_disposition_artifact evidence.']
        };
    }
    const expectedArtifactPath = getReviewFindingsDispositionArtifactPath(options.reviewArtifactPath);
    if (reference.artifact_path !== normalizePath(expectedArtifactPath)) {
        violations.push(
            `Review receipt review_findings_disposition_artifact artifact_path mismatch: ` +
            `expected ${normalizePath(expectedArtifactPath)}, found ${reference.artifact_path}.`
        );
    }
    if (!isPathRealpathInsideRoot(reference.artifact_path, options.repoRoot, { allowMissing: true })) {
        violations.push(
            `Review findings disposition artifact path must resolve inside repo root without symlink or junction escape: ` +
            `${reference.artifact_path}.`
        );
    }
    const artifactPathToRead = options.preferSnapshot && reference.snapshot_path
        ? reference.snapshot_path
        : reference.artifact_path;
    const artifactSha256ToRead = options.preferSnapshot && reference.snapshot_sha256
        ? reference.snapshot_sha256
        : reference.artifact_sha256;
    const artifactRecord = violations.length === 0
        ? readJsonRecord(artifactPathToRead, 'Review findings disposition artifact', violations)
        : null;
    const artifactSha256 = artifactRecord ? readReviewArtifactFileSha256(artifactPathToRead) : null;
    if (artifactSha256 && artifactSha256 !== artifactSha256ToRead) {
        violations.push(
            `Review findings disposition artifact '${artifactPathToRead}' sha256 mismatch: ` +
            `expected ${artifactSha256ToRead}, found ${artifactSha256}.`
        );
    }
    const expectedSnapshotPath = getReviewFindingsDispositionArtifactSnapshotPath(
        expectedArtifactPath,
        reference.artifact_sha256
    );
    if (reference.snapshot_path !== normalizePath(expectedSnapshotPath)) {
        violations.push(
            `Review receipt review_findings_disposition_artifact snapshot_path mismatch: ` +
            `expected ${normalizePath(expectedSnapshotPath)}, found ${reference.snapshot_path}.`
        );
    } else if (!isPathRealpathInsideRoot(reference.snapshot_path, options.repoRoot, { allowMissing: true })) {
        violations.push(
            `Review findings disposition snapshot path must resolve inside repo root without symlink or junction escape: ` +
            `${reference.snapshot_path}.`
        );
    } else {
        const snapshotRecord = readJsonRecord(
            reference.snapshot_path,
            'Review findings disposition snapshot',
            violations
        );
        const snapshotSha256 = snapshotRecord ? readReviewArtifactFileSha256(reference.snapshot_path) : null;
        if (snapshotSha256 && snapshotSha256 !== reference.snapshot_sha256) {
            violations.push(
                `Review findings disposition snapshot '${reference.snapshot_path}' sha256 mismatch: ` +
                `expected ${reference.snapshot_sha256}, found ${snapshotSha256}.`
            );
        }
        if (snapshotSha256 && snapshotSha256 !== reference.artifact_sha256) {
            violations.push(
                `Review findings disposition snapshot '${reference.snapshot_path}' does not match the receipt-bound artifact sha256.`
            );
        }
    }
    if (!artifactRecord) {
        return {
            valid: false,
            artifact: null,
            artifact_sha256: artifactSha256,
            follow_up_artifact_path: null,
            violations
        };
    }
    if (options.policyResolution.source === 'fallback_strict') {
        violations.push(
            'Required review findings dispositions must resolve from the locked profile snapshot or a bound reused receipt; ' +
            'fallback strict policy is not current-cycle evidence.'
        );
    }
    let expectedArtifact: ReviewFindingsDispositionArtifact | null = null;
    try {
        expectedArtifact = buildReviewFindingsDispositionArtifact({
            taskId: options.expectedTaskId,
            reviewType: options.expectedReviewType,
            validationArtifact: options.validationArtifact,
            validationArtifactPath: options.validationArtifactPath,
            validationArtifactSha256: options.validationArtifactSha256,
            policyResolution: options.policyResolution
        });
    } catch (error: unknown) {
        violations.push(error instanceof Error ? error.message : String(error));
    }
    if (!expectedArtifact) {
        return {
            valid: false,
            artifact: null,
            artifact_sha256: artifactSha256,
            follow_up_artifact_path: null,
            violations
        };
    }
    const expectedArtifactSha256 = sha256RedactedJsonPayload(expectedArtifact);
    if (artifactSha256 !== expectedArtifactSha256) {
        violations.push(
            `Review findings disposition artifact '${reference.artifact_path}' does not match the ` +
            'system-derived accepted findings and locked policy.'
        );
    }
    assertEqual(violations, 'Review findings disposition reference result sha256', reference.disposition_result_sha256, expectedArtifact.disposition_result_sha256);
    assertEqual(violations, 'Review findings disposition reference policy_id', reference.policy_id, expectedArtifact.policy.policy_id);
    assertEqual(violations, 'Review findings disposition reference policy_source', reference.policy_source, expectedArtifact.policy.policy_source);
    assertEqual(violations, 'Review findings disposition reference item_count', reference.item_count, expectedArtifact.summary.item_count);
    assertEqual(violations, 'Review findings disposition reference fix_now_count', reference.fix_now_count, expectedArtifact.summary.fix_now_count);
    assertEqual(violations, 'Review findings disposition reference follow_up_pending_count', reference.follow_up_pending_count, expectedArtifact.summary.follow_up_pending_count);
    assertEqual(violations, 'Review findings disposition reference ignored_count', reference.ignored_count, expectedArtifact.summary.ignored_count);
    assertEqual(violations, 'Review findings disposition reference blocking_count', reference.blocking_count, expectedArtifact.summary.blocking_count);
    assertEqual(
        violations,
        'Review receipt embedded findings disposition',
        sha256RedactedJsonPayload(options.receipt.review_findings_disposition),
        expectedArtifact.disposition_result_sha256
    );
    const outputContract = toPlainRecord(options.receipt.review_output_contract);
    assertEqual(violations, 'Review output contract disposition artifact sha256', normalizeHash(outputContract?.disposition_artifact_sha256), expectedArtifactSha256);
    assertEqual(violations, 'Review output contract disposition result sha256', normalizeHash(outputContract?.disposition_result_sha256), expectedArtifact.disposition_result_sha256);
    if (expectedArtifact.summary.fix_now_count > 0 || expectedArtifact.summary.blocking_count > 0) {
        violations.push(
            `Review findings disposition artifact contains ${expectedArtifact.summary.fix_now_count} unsatisfied fix_now ` +
            'finding(s) or residual risk(s).'
        );
    }
    const followUp = validateFollowUpSatisfaction({
        repoRoot: options.repoRoot,
        receiptPath: options.receiptPath,
        dispositionArtifactPath: reference.artifact_path,
        dispositionArtifactSha256: expectedArtifactSha256,
        dispositionArtifact: expectedArtifact,
        validationArtifactPath: options.validationArtifactPath,
        validationArtifactSha256: options.validationArtifactSha256,
        validationArtifact: options.validationArtifact,
        taskId: options.expectedTaskId,
        reviewType: options.expectedReviewType,
        expectedReceiptPath: options.expectedReceiptPath,
        expectedReceiptSha256: options.expectedReceiptSha256,
        taskQueueRows: options.taskQueueRows
    });
    violations.push(...followUp.violations);
    return {
        valid: violations.length === 0,
        artifact: artifactRecord as unknown as ReviewFindingsDispositionArtifact,
        artifact_sha256: artifactSha256,
        follow_up_artifact_path: followUp.artifactPath,
        violations
    };
}

export function validateReviewFindingsDispositionEvidence(
    options: ReviewFindingsDispositionEvidenceCheckOptions
): ReviewFindingsDispositionEvidenceCheckResult {
    const reviewsRoot = path.dirname(path.resolve(getReviewFindingsDispositionArtifactPath(options.reviewArtifactPath)));
    return withReviewArtifactReadBarrier(
        reviewsRoot,
        () => validateReviewFindingsDispositionEvidenceUnlocked(options)
    );
}
