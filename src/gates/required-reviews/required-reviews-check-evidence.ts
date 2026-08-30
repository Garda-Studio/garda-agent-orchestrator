// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ReviewReceipt } from '../../gate-runtime/review-context';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactJsonFile,
    withReviewArtifactReadBarrier
} from '../../gate-runtime/review-artifacts';
import { isPathRealpathInsideRoot, normalizePath, toPlainRecord } from '../shared/helpers';

function readPreflightPayloadForReviewValidation(preflightPath?: string | null): Record<string, unknown> | null {
    const resolvedPath = String(preflightPath || '').trim();
    if (!resolvedPath) {
        return null;
    }
    try {
        return toPlainRecord(readReviewArtifactJsonFile(resolvedPath));
    } catch {
        return null;
    }
}

export function resolvePreflightPayloadForReviewValidation(options: {
    preflightPayload?: Record<string, unknown> | null;
    preflightPath?: string | null;
}): Record<string, unknown> | null {
    return toPlainRecord(options.preflightPayload)
        ?? readPreflightPayloadForReviewValidation(options.preflightPath);
}

export function normalizeSha256String(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
}

export function resolveReviewContextTreeStateSha256(reviewContext?: Record<string, unknown>): string | null {
    const treeState = toPlainRecord(reviewContext?.tree_state);
    return normalizeSha256String(treeState?.tree_state_sha256);
}

export interface ReviewArtifactEntry {
    path: string;
    content: string;
    reviewContext?: Record<string, unknown>;
    reviewContextPath?: string | null;
    reviewContextSha256?: string | null;
    artifactSha256?: string | null;
    receipt?: ReviewReceipt | null;
    receiptReadError?: string | null;
}

export function readReviewReceiptSnapshot(options: {
    reviewKey: string;
    reviewArtifact: ReviewArtifactEntry;
    artifactPath: string;
    receiptPath: string;
}): {
    artifactSha256: string | null;
    receipt: ReviewReceipt | null;
    receiptReadError: string | null;
} {
    const readArtifactSha256IfAvailable = (): string | null => {
        if (options.reviewArtifact.artifactSha256) {
            return options.reviewArtifact.artifactSha256;
        }
        if (!options.artifactPath) {
            return null;
        }
        try {
            if (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile()) {
                return null;
            }
            return readReviewArtifactFileSha256(options.artifactPath);
        } catch {
            return null;
        }
    };
    if (options.reviewArtifact.receipt || options.reviewArtifact.receiptReadError) {
        return {
            artifactSha256: readArtifactSha256IfAvailable(),
            receipt: options.reviewArtifact.receipt ?? null,
            receiptReadError: options.reviewArtifact.receiptReadError ?? null
        };
    }
    if (!fs.existsSync(options.receiptPath)) {
        return {
            artifactSha256: readArtifactSha256IfAvailable(),
            receipt: null,
            receiptReadError: null
        };
    }
    const reviewsRoot = path.dirname(path.resolve(options.receiptPath));
    return withReviewArtifactReadBarrier(reviewsRoot, () => {
        if (!fs.existsSync(options.receiptPath) || !fs.statSync(options.receiptPath).isFile()) {
            return {
                artifactSha256: readArtifactSha256IfAvailable(),
                receipt: null,
                receiptReadError: null
            };
        }
        try {
            const receipt = readReviewArtifactJsonFile(options.receiptPath) as ReviewReceipt;
            return {
                artifactSha256: readArtifactSha256IfAvailable(),
                receipt,
                receiptReadError: null
            };
        } catch {
            return {
                artifactSha256: readArtifactSha256IfAvailable(),
                receipt: null,
                receiptReadError: `Review receipt for '${options.reviewKey}' is invalid JSON: ${normalizePath(options.receiptPath)}.`
            };
        }
    });
}

export function validateDerivedReviewReceiptPath(options: {
    reviewKey: string;
    artifactPath: string;
    receiptPath: string;
    repoRoot: string | null;
}): string | null {
    if (!options.repoRoot) {
        return null;
    }
    const receiptPath = path.resolve(options.receiptPath);
    const repoRoot = path.resolve(options.repoRoot);
    const artifactDir = path.dirname(path.resolve(options.artifactPath));
    if (
        !isPathRealpathInsideRoot(receiptPath, repoRoot, { allowMissing: true })
        || !isPathRealpathInsideRoot(receiptPath, artifactDir, { allowMissing: true })
    ) {
        return `Review receipt path for '${options.reviewKey}' must resolve inside repo root and review artifact directory without symlink or junction escape: ${normalizePath(receiptPath)}.`;
    }
    return null;
}
