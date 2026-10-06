import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
    invalidateIndex as invalidateReviewsIndex,
    rebuildIndex
} from '../../gate-runtime/reviews-index';
import {
    parseActiveReviewArtifactTaskId,
    parseStructuredTaskArtifactTaskId
} from '../../core/task-ids';
import { ensureWithinRoot } from '../generic-utils';
import { hasConsistentReviewArtifactTaskId } from './cleanup-review-artifact-ownership';
import type {
    ReviewArtifactRetentionMode,
    ReviewArtifactStoragePolicy,
    StoragePolicyResult
} from './cleanup-types';

const DEFAULT_STORAGE_POLICY: ReviewArtifactStoragePolicy = {
    retentionMode: 'full',
    compressAfterDays: 7,
    compressionFormat: 'gzip',
    preserveGateReceipts: true,
    gateReceiptSuffixes: [
        '-task-mode.json',
        '-preflight.json',
        '-compile-gate.json',
        '-completion-gate.json',
        '-rule-pack.json',
        '-handshake.json'
    ]
};

const HEAVY_FORENSIC_REVIEW_SUFFIXES: readonly string[] = Object.freeze([
    '-compile-output.log',
    '-full-suite-output.log',
    '-dependency-review-context.json',
    '-performance-review-context.json',
    '-security-review-context.json',
    '-refactor-review-context.json',
    '-infra-review-context.json',
    '-code-review-context.json',
    '-test-review-context.json',
    '-api-review-context.json',
    '-db-review-context.json',
    '-dependency-review-output.md',
    '-performance-review-output.md',
    '-security-review-output.md',
    '-refactor-review-output.md',
    '-infra-review-output.md',
    '-code-review-output.md',
    '-test-review-output.md',
    '-api-review-output.md',
    '-db-review-output.md',
    '-dependency-scoped.diff',
    '-performance-scoped.diff',
    '-security-scoped.diff',
    '-refactor-scoped.diff',
    '-infra-scoped.diff',
    '-code-scoped.diff',
    '-test-scoped.diff',
    '-api-scoped.diff',
    '-db-scoped.diff'
]);

function validateRetentionMode(value: unknown): ReviewArtifactRetentionMode {
    if (value === 'none' || value === 'summary' || value === 'full') return value;
    return 'full';
}

export function loadStoragePolicy(bundleRoot: string): ReviewArtifactStoragePolicy {
    const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
    if (!fs.existsSync(configPath)) {
        return { ...DEFAULT_STORAGE_POLICY };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return {
            retentionMode: validateRetentionMode(raw.retention_mode),
            compressAfterDays: typeof raw.compress_after_days === 'number' && raw.compress_after_days >= 0
                ? raw.compress_after_days
                : DEFAULT_STORAGE_POLICY.compressAfterDays,
            compressionFormat: raw.compression_format === 'gzip'
                ? 'gzip'
                : DEFAULT_STORAGE_POLICY.compressionFormat,
            preserveGateReceipts: typeof raw.preserve_gate_receipts === 'boolean'
                ? raw.preserve_gate_receipts
                : DEFAULT_STORAGE_POLICY.preserveGateReceipts,
            gateReceiptSuffixes: Array.isArray(raw.gate_receipt_suffixes)
                ? raw.gate_receipt_suffixes.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
                : [...DEFAULT_STORAGE_POLICY.gateReceiptSuffixes]
        };
    } catch {
        return { ...DEFAULT_STORAGE_POLICY };
    }
}

export function isGateReceipt(fileName: string, suffixes: string[]): boolean {
    return suffixes.some((suffix) => fileName.endsWith(suffix));
}

export function compressFileGzip(filePath: string): string {
    const compressedPath = `${filePath}.gz`;
    const tmpPath = `${compressedPath}.tmp`;
    if (fs.existsSync(compressedPath) || fs.existsSync(tmpPath)) {
        throw new Error('Compression output already exists.');
    }
    const content = fs.readFileSync(filePath);
    const compressed = zlib.gzipSync(content);
    const fd = fs.openSync(tmpPath, 'wx');
    try {
        fs.writeFileSync(fd, compressed);
        fs.copyFileSync(tmpPath, compressedPath, fs.constants.COPYFILE_EXCL);
        fs.unlinkSync(filePath);
    } finally {
        fs.closeSync(fd);
        fs.unlinkSync(tmpPath);
    }
    return compressedPath;
}

function isHeavyForensicReviewArtifact(fileName: string, artifactType: string): boolean {
    if (HEAVY_FORENSIC_REVIEW_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
        return true;
    }
    return artifactType.endsWith('-review-context.json')
        || artifactType.endsWith('-review-output.md')
        || artifactType.endsWith('-scoped.diff');
}

function buildEmptyStoragePolicyResult(retentionMode: ReviewArtifactRetentionMode): StoragePolicyResult {
    return {
        compressed: [],
        removed: [],
        preserved: [],
        retentionMode
    };
}

export function applyForensicCompressionPolicy(
    reviewsDir: string,
    forensicTaskIds: ReadonlySet<string>,
    runtimeRoot = path.dirname(reviewsDir)
): StoragePolicyResult {
    const result = buildEmptyStoragePolicyResult('full');
    if (forensicTaskIds.size === 0) return result;

    let safeReviewsDir: string;
    try {
        safeReviewsDir = ensureWithinRoot(runtimeRoot, reviewsDir, 'Reviews directory');
    } catch {
        return result;
    }

    if (!fs.existsSync(safeReviewsDir)) return result;

    let entries: string[];
    try {
        entries = fs.readdirSync(safeReviewsDir).sort();
    } catch {
        return result;
    }

    const indexedEntriesByFileName = new Map(
        rebuildIndex(safeReviewsDir).entries.map((entry) => [entry.fileName, entry])
    );
    for (const entry of entries) {
        const indexedEntry = indexedEntriesByFileName.get(entry);
        if (
            entry.endsWith('.gz')
            || !indexedEntry
            || !isHeavyForensicReviewArtifact(entry, indexedEntry.artifactType)
        ) continue;

        if (!forensicTaskIds.has(indexedEntry.taskId)) continue;

        const filePath = path.join(safeReviewsDir, entry);
        let safeFilePath: string;
        try {
            safeFilePath = ensureWithinRoot(runtimeRoot, filePath, 'Review artifact');
            if (!fs.statSync(safeFilePath).isFile()
                || !hasConsistentReviewArtifactTaskId(safeFilePath, indexedEntry.taskId)) {
                result.preserved.push(entry);
                continue;
            }
        } catch {
            result.preserved.push(entry);
            continue;
        }

        if (fs.existsSync(`${safeFilePath}.gz`)) {
            result.preserved.push(entry);
            continue;
        }

        try {
            compressFileGzip(safeFilePath);
            result.compressed.push(entry);
        } catch {
            result.preserved.push(entry);
        }
    }

    if (result.compressed.length > 0) {
        try {
            invalidateReviewsIndex(safeReviewsDir);
        } catch {
            // Best-effort index invalidation.
        }
    }

    return result;
}

export function applyStoragePolicy(
    reviewsDir: string,
    policy: ReviewArtifactStoragePolicy,
    protectedTaskIds: Set<string>,
    runtimeRoot = path.dirname(reviewsDir),
    targetTaskIds?: ReadonlySet<string>
): StoragePolicyResult {
    const result = buildEmptyStoragePolicyResult(policy.retentionMode);

    let safeReviewsDir: string;
    try {
        safeReviewsDir = ensureWithinRoot(runtimeRoot, reviewsDir, 'Reviews directory');
    } catch {
        return result;
    }

    if (!fs.existsSync(safeReviewsDir)) return result;

    let entries: string[];
    try {
        entries = fs.readdirSync(safeReviewsDir).sort();
    } catch {
        return result;
    }

    const now = Date.now();
    const compressCutoffMs = policy.compressAfterDays > 0
        ? policy.compressAfterDays * 24 * 60 * 60 * 1000
        : 0;

    const indexedTaskIdsByFileName = new Map(
        rebuildIndex(safeReviewsDir).entries.map((entry) => [entry.fileName, entry.taskId])
    );
    for (const entry of entries) {
        if (!entry.endsWith('.json') && !entry.endsWith('.md') && !entry.endsWith('.diff')) continue;

        const filePath = path.join(safeReviewsDir, entry);
        let safeFilePath: string;
        try {
            safeFilePath = ensureWithinRoot(runtimeRoot, filePath, 'Review artifact');
        } catch {
            result.preserved.push(entry);
            continue;
        }
        const taskId = parseActiveReviewArtifactTaskId(entry, protectedTaskIds)
            ?? indexedTaskIdsByFileName.get(entry)
            ?? parseStructuredTaskArtifactTaskId(entry)
            ?? null;
        if (!taskId) continue;
        if (targetTaskIds && !targetTaskIds.has(taskId)) {
            result.preserved.push(entry);
            continue;
        }
        if (protectedTaskIds.has(taskId)) {
            result.preserved.push(entry);
            continue;
        }
        if (!hasConsistentReviewArtifactTaskId(safeFilePath, taskId)) {
            result.preserved.push(entry);
            continue;
        }

        const receipt = isGateReceipt(entry, policy.gateReceiptSuffixes);

        if (policy.retentionMode === 'none') {
            if (policy.preserveGateReceipts && receipt) {
                result.preserved.push(entry);
            } else {
                try {
                    fs.unlinkSync(safeFilePath);
                    result.removed.push(entry);
                } catch {
                    result.preserved.push(entry);
                }
            }
            continue;
        }

        if (policy.retentionMode === 'summary') {
            if (receipt) {
                result.preserved.push(entry);
            } else {
                try {
                    fs.unlinkSync(safeFilePath);
                    result.removed.push(entry);
                } catch {
                    result.preserved.push(entry);
                }
            }
            continue;
        }

        if (compressCutoffMs > 0) {
            try {
                const stat = fs.statSync(safeFilePath);
                if (now - stat.mtimeMs > compressCutoffMs) {
                    compressFileGzip(safeFilePath);
                    result.compressed.push(entry);
                    continue;
                }
            } catch {
                // Skip unreadable files.
            }
        }

        result.preserved.push(entry);
    }

    if (result.removed.length > 0 || result.compressed.length > 0) {
        try {
            invalidateReviewsIndex(safeReviewsDir);
        } catch {
            // Best-effort index invalidation.
        }
    }

    return result;
}
