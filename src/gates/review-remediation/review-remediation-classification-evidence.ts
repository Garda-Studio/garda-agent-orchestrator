import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertTransactionPath, readTransactionBytes } from '../../core/file-transaction-journal';
import { parseJsonText } from '../../core/json';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { pathsEqual } from '../review-reuse/review-reuse-telemetry-normalization';

const MAX_CLASSIFICATION_SNAPSHOT_BYTES = 64 * 1024 * 1024;

interface ReviewClassificationReference {
    schema_version: 1;
    artifact_path: string;
    artifact_sha256: string;
}

function snapshotPath(reviewsRoot: string, taskId: string, sha256: string): string {
    return path.join(path.resolve(reviewsRoot), `${assertCanonicalTaskId(taskId)}-review-classification-${sha256}.json`);
}

function bytesSha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export function writeReviewClassificationSnapshot(options: {
    reviewsRoot: string;
    taskId: string;
    classification: Record<string, unknown>;
}): ReviewClassificationReference {
    const bytes = Buffer.from(`${JSON.stringify({
        schema_version: 1,
        artifact_type: 'review_remediation_classification',
        task_id: options.taskId,
        classification: options.classification
    })}\n`, 'utf8');
    if (bytes.length > MAX_CLASSIFICATION_SNAPSHOT_BYTES) throw new Error('Review classification snapshot is oversized.');
    const sha256 = bytesSha256(bytes);
    const artifactPath = snapshotPath(options.reviewsRoot, options.taskId, sha256);
    fs.mkdirSync(options.reviewsRoot, { recursive: true });
    assertTransactionPath(options.reviewsRoot, artifactPath);
    try {
        fs.writeFileSync(artifactPath, bytes, { flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readTransactionBytes(options.reviewsRoot, artifactPath, MAX_CLASSIFICATION_SNAPSHOT_BYTES);
        if (!existing || bytesSha256(existing) !== sha256) throw new Error('Existing review classification snapshot does not match its hash.');
    }
    return { schema_version: 1, artifact_path: artifactPath.replace(/\\/gu, '/'), artifact_sha256: sha256 };
}

export function readRestartReviewClassification(options: {
    reviewsRoot: string;
    taskId: string;
    details: Readonly<Record<string, unknown>>;
}): unknown {
    const reference = options.details.authoritative_review_classification_reference;
    // Existing timelines retain their inline representation and validation rules.
    if (reference === undefined) return options.details.authoritative_review_classification;
    if (options.details.authoritative_review_classification !== undefined
        || !isPlainRecord(reference) || reference.schema_version !== 1
        || typeof reference.artifact_path !== 'string'
        || typeof reference.artifact_sha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(reference.artifact_sha256)) {
        throw new Error('Invalid review classification snapshot reference.');
    }
    const artifactPath = snapshotPath(options.reviewsRoot, options.taskId, reference.artifact_sha256);
    if (!pathsEqual(reference.artifact_path, artifactPath)) throw new Error('Review classification snapshot path is not canonical.');
    const bytes = readTransactionBytes(options.reviewsRoot, artifactPath, MAX_CLASSIFICATION_SNAPSHOT_BYTES);
    if (!bytes || bytesSha256(bytes) !== reference.artifact_sha256) throw new Error('Review classification snapshot is missing or its hash does not match.');
    const artifact = parseJsonText(bytes.toString('utf8'), artifactPath);
    if (!isPlainRecord(artifact) || artifact.schema_version !== 1
        || artifact.artifact_type !== 'review_remediation_classification'
        || artifact.task_id !== options.taskId || !isPlainRecord(artifact.classification)) {
        throw new Error('Review classification snapshot has invalid task or schema bindings.');
    }
    return artifact.classification;
}
