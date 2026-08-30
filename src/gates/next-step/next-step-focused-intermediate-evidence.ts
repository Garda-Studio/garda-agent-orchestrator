import * as fs from 'node:fs';

import { readReviewArtifactTextFile } from '../../gate-runtime/review-artifacts';
import { normalizePath } from '../shared/helpers';
import {
    isFocusedReviewTestPath,
    isPassedIntermediateCommandEvent,
    readTaskOwnedFocusedIntermediateEvidence
} from '../review/focused-intermediate-evidence';
import { findReviewFocusedFindingTestPaths } from './next-step-review-artifact-failure-detection';
import {
    findReviewFindingsValidationMissingFocusedValidationTestPaths,
    getReviewFindingsValidationArtifactPath,
    validateReviewFindingsValidationArtifact
} from '../review/review-findings-validation-artifact';

export { isPassedIntermediateCommandEvent };

export interface FocusedIntermediateReviewEvidence {
    available: boolean;
    reason: string | null;
}

export function readFocusedTestRequiredByReview(options: {
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
}): string | null {
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(options.reviewArtifactPath);
    if (fs.existsSync(validationArtifactPath)) {
        const validationArtifact = validateReviewFindingsValidationArtifact({
            artifactPath: validationArtifactPath,
            expectedTaskId: options.taskId,
            expectedReviewType: options.reviewType,
            requireAccepted: true
        });
        if (validationArtifact.valid) {
            const findingTestPaths = findReviewFindingsValidationMissingFocusedValidationTestPaths(validationArtifact.artifact)
                .map((filePath) => normalizePath(filePath))
                .filter((filePath) => filePath && isFocusedReviewTestPath(filePath));
            return findingTestPaths.length === 1 ? findingTestPaths[0] : null;
        }
    }
    if (!fs.existsSync(options.reviewArtifactPath)) {
        return null;
    }
    try {
        const reviewContent = readReviewArtifactTextFile(options.reviewArtifactPath);
        const findingTestPaths = findReviewFocusedFindingTestPaths(reviewContent)
            .map((filePath) => normalizePath(filePath))
            .filter((filePath) => filePath && isFocusedReviewTestPath(filePath));
        return findingTestPaths.length === 1 ? findingTestPaths[0] : null;
    } catch {
        return null;
    }
}

function parseUtcTimestamp(value: string | null): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

export function readPostReviewFocusedIntermediateEvidence(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
    reviewResultRecordedAtUtc: string | null;
    reviewerProvenanceTaskSequence: number | null;
    changedFiles: readonly string[];
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
}): FocusedIntermediateReviewEvidence {
    const reviewResultTimestamp = parseUtcTimestamp(options.reviewResultRecordedAtUtc);
    const requiredFocusedTest = readFocusedTestRequiredByReview({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewArtifactPath: options.reviewArtifactPath
    });
    if (
        reviewResultTimestamp == null
        || options.reviewerProvenanceTaskSequence == null
        || !requiredFocusedTest
    ) {
        return { available: false, reason: null };
    }
    const selection = readTaskOwnedFocusedIntermediateEvidence({
        repoRoot: options.repoRoot,
        reviewsRoot: options.reviewsRoot,
        eventsRoot: options.eventsRoot,
        taskId: options.taskId,
        changedFiles: options.changedFiles,
        requiredTestPath: requiredFocusedTest,
        minimumTimestampExclusive: reviewResultTimestamp,
        minimumTaskSequenceExclusive: options.reviewerProvenanceTaskSequence,
        expectedPreflightPath: options.expectedPreflightPath,
        expectedPreflightSha256: options.expectedPreflightSha256,
        expectedCoverageContractSha256: options.expectedCoverageContractSha256,
        maxEntries: 1
    });
    const evidence = selection.entries[0];
    if (!evidence) {
        return { available: false, reason: null };
    }
    return {
        available: true,
        reason:
            `Current task-owned focused validation evidence: ${evidence.artifact_path}; ` +
            `command_source=${evidence.command_source}; focused_test=${requiredFocusedTest}.`
    };
}
