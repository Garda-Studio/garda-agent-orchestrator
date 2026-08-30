// Extracted from review-reuse-telemetry.ts; keep behavior changes covered by facade tests.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';
import {
    type HistoricalReviewRecordedRuntimeReviewPathValidation,
    type HistoricalReviewRecordedSnapshotValidation
} from './review-reuse-telemetry-types';
import {
    hasParentPathSegment,
    isSafeArtifactSegment,
    normalizeArtifactSegment,
    normalizeEventSequence,
    normalizeLowerString,
    pathsEqual,
    pathIsInsideOrEqual,
    isPlainRecord
} from './review-reuse-telemetry-normalization';

export function validateHistoricalReviewRecordedRuntimeReviewPath(options: {
    repoRoot?: string | null;
    rawPath: unknown;
    taskId?: string | null;
    reviewType?: string | null;
    expectedFileName: string;
    artifactLabel: string;
    missingReason: string;
    hashForMessage?: string | null;
}): HistoricalReviewRecordedRuntimeReviewPathValidation {
    const rawPath = String(options.rawPath || '').trim();
    const artifactLabel = String(options.artifactLabel || 'historical review artifact').trim();
    const expectedFileName = String(options.expectedFileName || '').trim();
    const taskId = normalizeArtifactSegment(options.taskId);
    const reviewType = normalizeArtifactSegment(options.reviewType).toLowerCase();
    if (!rawPath) {
        return {
            valid: false,
            reason: options.missingReason,
            message: `${artifactLabel} path is missing from REVIEW_RECORDED telemetry`,
            resolvedPath: null
        };
    }
    if (!isSafeArtifactSegment(taskId) || !isSafeArtifactSegment(reviewType) || !expectedFileName) {
        return {
            valid: false,
            reason: `${options.missingReason}_expected_identity_invalid`,
            message: `${artifactLabel} cannot be validated because task or review identity is invalid`,
            resolvedPath: null
        };
    }
    const root = String(options.repoRoot || '').trim();
    if (!root) {
        return {
            valid: false,
            reason: `${options.missingReason}_repo_root_missing`,
            message: `${artifactLabel} path cannot be validated because repo root is unavailable`,
            resolvedPath: null
        };
    }
    if (hasParentPathSegment(rawPath)) {
        return {
            valid: false,
            reason: `${options.missingReason}_path_traversal`,
            message: `${artifactLabel} path must not contain parent-directory traversal segments`,
            resolvedPath: null
        };
    }
    const reviewsRoot = path.resolve(joinOrchestratorPath(root, path.join('runtime', 'reviews')));
    const expectedPath = path.join(reviewsRoot, expectedFileName);
    const resolvedPath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(root, rawPath);
    if (!pathsEqual(resolvedPath, expectedPath)) {
        return {
            valid: false,
            reason: `${options.missingReason}_noncanonical_path`,
            message: `${artifactLabel} path must reference canonical runtime review artifact ${normalizePath(expectedPath)}`,
            resolvedPath
        };
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            valid: false,
            reason: `${options.missingReason}_missing`,
            message: `${artifactLabel} is missing at ${normalizePath(resolvedPath)}`,
            resolvedPath
        };
    }
    const realReviewsRoot = fs.existsSync(reviewsRoot)
        ? fs.realpathSync.native(reviewsRoot)
        : reviewsRoot;
    const realResolvedPath = fs.realpathSync.native(resolvedPath);
    if (!pathIsInsideOrEqual(realResolvedPath, realReviewsRoot)) {
        return {
            valid: false,
            reason: `${options.missingReason}_realpath_escape`,
            message: `${artifactLabel} real path escapes the runtime review artifacts directory`,
            resolvedPath
        };
    }
    return {
        valid: true,
        reason: null,
        message: null,
        resolvedPath
    };
}

export function validateHistoricalReviewRecordedReviewArtifactPath(
    details: Record<string, unknown>,
    repoRoot?: string | null,
    options: { taskId?: string | null; reviewType?: string | null } = {}
): HistoricalReviewRecordedSnapshotValidation {
    const taskId = normalizeArtifactSegment(options.taskId ?? details.task_id ?? details.taskId);
    const reviewType = normalizeArtifactSegment(options.reviewType ?? details.review_type ?? details.reviewType).toLowerCase();
    const artifactPathRaw = String(
        details.review_artifact_snapshot_path
            ?? details.reviewArtifactSnapshotPath
            ?? ''
    ).trim();
    const expectedSha256 = normalizeLowerString(
        details.review_artifact_snapshot_sha256
            ?? details.reviewArtifactSnapshotSha256
    );
    if (!artifactPathRaw) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_path_missing',
            message: 'historical review artifact snapshot path is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: expectedSha256 || null,
            actualSha256: null
        };
    }
    if (!expectedSha256) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_hash_missing',
            message: 'historical review artifact snapshot hash is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: null,
            actualSha256: null
        };
    }
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_hash_invalid',
            message: `historical review artifact snapshot hash is invalid in REVIEW_RECORDED telemetry: ${expectedSha256}`,
            resolvedPath: null,
            expectedSha256,
            actualSha256: null
        };
    }
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot,
        rawPath: artifactPathRaw,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-artifact-${expectedSha256}.md`,
        artifactLabel: 'historical review artifact snapshot',
        missingReason: 'review_artifact_snapshot_path'
    });
    if (!pathValidation.valid) {
        return {
            valid: false,
            reason: pathValidation.reason,
            message: pathValidation.message,
            resolvedPath: pathValidation.resolvedPath,
            expectedSha256,
            actualSha256: null
        };
    }
    const actualSha256 = normalizeLowerString(readReviewArtifactFileSha256(pathValidation.resolvedPath));
    if (actualSha256 !== expectedSha256) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_hash_mismatch',
            message: `historical review artifact snapshot hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256 || 'missing'})`,
            resolvedPath: pathValidation.resolvedPath,
            expectedSha256,
            actualSha256: actualSha256 || null
        };
    }
    return {
        valid: true,
        reason: null,
        message: null,
        resolvedPath: pathValidation.resolvedPath,
        expectedSha256,
        actualSha256
    };
}

export function validateHistoricalReviewRecordedReceiptSnapshot(
    details: Record<string, unknown>,
    repoRoot?: string | null,
    options: { taskId?: string | null; reviewType?: string | null } = {}
): HistoricalReviewRecordedSnapshotValidation {
    const receiptPathRaw = String(
        details.receipt_snapshot_path
            ?? details.receiptSnapshotPath
            ?? ''
    ).trim();
    const expectedSha256 = normalizeLowerString(
        details.receipt_snapshot_sha256
            ?? details.receiptSnapshotSha256
    );
    if (!receiptPathRaw) {
        return {
            valid: false,
            reason: 'receipt_snapshot_path_missing',
            message: 'historical review receipt snapshot path is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: expectedSha256 || null,
            actualSha256: null
        };
    }
    if (!expectedSha256) {
        return {
            valid: false,
            reason: 'receipt_snapshot_hash_missing',
            message: 'historical review receipt snapshot hash is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: null,
            actualSha256: null
        };
    }
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return {
            valid: false,
            reason: 'receipt_snapshot_hash_invalid',
            message: `historical review receipt snapshot hash is invalid in REVIEW_RECORDED telemetry: ${expectedSha256}`,
            resolvedPath: null,
            expectedSha256,
            actualSha256: null
        };
    }
    const taskId = normalizeArtifactSegment(options.taskId ?? details.task_id ?? details.taskId);
    const reviewType = normalizeArtifactSegment(options.reviewType ?? details.review_type ?? details.reviewType).toLowerCase();
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot,
        rawPath: receiptPathRaw,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-receipt-${expectedSha256}.json`,
        artifactLabel: 'historical review receipt snapshot',
        missingReason: 'receipt_snapshot_path'
    });
    if (!pathValidation.valid) {
        return {
            valid: false,
            reason: pathValidation.reason,
            message: pathValidation.message,
            resolvedPath: pathValidation.resolvedPath,
            expectedSha256,
            actualSha256: null
        };
    }
    const resolvedPath = pathValidation.resolvedPath;
    const actualSha256 = normalizeLowerString(readReviewArtifactFileSha256(resolvedPath));
    if (actualSha256 !== expectedSha256) {
        return {
            valid: false,
            reason: 'receipt_snapshot_hash_mismatch',
            message: `historical review receipt snapshot hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256 || 'missing'})`,
            resolvedPath,
            expectedSha256,
            actualSha256: actualSha256 || null
        };
    }
    return {
        valid: true,
        reason: null,
        message: null,
        resolvedPath,
        expectedSha256,
        actualSha256
    };
}

export function validateHistoricalReviewRecordedSnapshotBindings(
    details: Record<string, unknown>
): { valid: true; reason: null } | { valid: false; reason: string } {
    const receiptSha256 = normalizeLowerString(details.receipt_sha256 ?? details.receiptSha256);
    const receiptSnapshotSha256 = normalizeLowerString(details.receipt_snapshot_sha256 ?? details.receiptSnapshotSha256);
    if (!receiptSha256) {
        return { valid: false, reason: 'receipt_hash_missing' };
    }
    if (receiptSnapshotSha256 !== receiptSha256) {
        return { valid: false, reason: 'receipt_snapshot_hash_not_bound_to_receipt_hash' };
    }
    const reviewArtifactSha256 = normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256);
    const reviewArtifactSnapshotSha256 = normalizeLowerString(
        details.review_artifact_snapshot_sha256
            ?? details.reviewArtifactSnapshotSha256
    );
    if (!reviewArtifactSha256) {
        return { valid: false, reason: 'review_artifact_hash_missing' };
    }
    if (reviewArtifactSnapshotSha256 !== reviewArtifactSha256) {
        return { valid: false, reason: 'review_artifact_snapshot_hash_not_bound_to_artifact_hash' };
    }
    return { valid: true, reason: null };
}

export function reviewerProvenanceMatches(actual: unknown, expected: Record<string, unknown>): boolean {
    const actualRecord = isPlainRecord(actual) ? actual : {};
    const stringFields = [
        'attestation_type',
        'controller_event_type',
        'event_sha256',
        'prev_event_sha256',
        'task_id',
        'review_type',
        'reviewer_execution_mode',
        'reviewer_identity',
        'review_context_sha256',
        'review_tree_state_sha256',
        'routing_event_sha256'
    ];
    for (const field of stringFields) {
        const actualValue = actualRecord[field] == null
            ? null
            : String(actualRecord[field]).trim().toLowerCase() || null;
        const expectedValue = expected[field] == null
            ? null
            : String(expected[field]).trim().toLowerCase() || null;
        if (actualValue !== expectedValue) {
            return false;
        }
    }
    const actualTaskSequence = normalizeEventSequence(actualRecord.task_sequence);
    const expectedTaskSequence = normalizeEventSequence(expected.task_sequence);
    return actualTaskSequence === expectedTaskSequence;
}
