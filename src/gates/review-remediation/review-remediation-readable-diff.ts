import { countNextStepWork } from '../../core/next-step-measurement';
import { createHash } from 'node:crypto';

import { redactSensitiveData } from '../../core/redaction';
import type { ReviewRemediationDeltaBaseEntry } from './review-remediation-delta-contract';

export const REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS = 250000;
export const REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES = 16 * 1024;

export type ReviewRemediationReadableDiffOperation = 'context' | 'addition' | 'deletion';

export interface ReviewRemediationReadableDiffLine {
    operation: ReviewRemediationReadableDiffOperation;
    baseline_line: number | null;
    current_line: number | null;
    segment_index: number;
    segment_count: number;
    text: string;
    source_line_sha256: string;
}

export interface ReviewRemediationReadableDiffPage {
    page_number: number;
    page_count: number;
    path: string;
    lines: ReviewRemediationReadableDiffLine[];
    utf8_bytes: number;
    page_sha256: string;
}

export interface ReviewRemediationReadableDiffEvidence {
    schema_version: 1;
    format: 'redacted_line_operations_v1';
    page_max_bytes: typeof REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES;
    page_count: number;
    pages: ReviewRemediationReadableDiffPage[];
    evidence_sha256: string;
}

export interface ReviewRemediationLineDelta {
    additions: number | null;
    deletions: number | null;
    changedLines: number | null;
    unavailableReason: string | null;
    readableLines: ReviewRemediationReadableDiffLine[] | null;
}

export type ReviewRemediationLineComparisonBudget = { remainingWorkUnits: number };

type ReviewRemediationEditAtom = {
    operation: ReviewRemediationReadableDiffOperation;
    baselineIndex: number | null;
    currentIndex: number | null;
};

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function serializeExactJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256ReviewRemediationReadableDiffPayload(value: unknown): string {
    return createHash('sha256').update(serializeExactJson(value)).digest('hex');
}

export function isReviewRemediationReadableDiffPayloadRedacted(value: unknown): boolean {
    return serializeExactJson(value) === serializeExactJson(redactSensitiveData(value));
}

function consumeLineComparisonWork(budget: ReviewRemediationLineComparisonBudget): boolean {
    if (budget.remainingWorkUnits <= 0) {
        return false;
    }
    budget.remainingWorkUnits -= 1;
    return true;
}

export function getLcsLength(
    left: readonly string[],
    right: readonly string[],
    budget: ReviewRemediationLineComparisonBudget = {
        remainingWorkUnits: REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
    }
): number | null {
    const leftLength = left.length;
    const rightLength = right.length;
    const maxDistance = leftLength + rightLength;
    const furthest = new Map<number, number>([[1, 0]]);
    for (let distance = 0; distance <= maxDistance; distance += 1) {
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            if (!consumeLineComparisonWork(budget)) {
                return null;
            }
            const down = furthest.get(diagonal + 1) ?? -1;
            const rightward = (furthest.get(diagonal - 1) ?? -1) + 1;
            let x = diagonal === -distance || (diagonal !== distance && down > rightward)
                ? down
                : rightward;
            if (x < 0) {
                x = 0;
            }
            let y = x - diagonal;
            while (x < leftLength && y < rightLength && left[x] === right[y]) {
                if (!consumeLineComparisonWork(budget)) {
                    return null;
                }
                x += 1;
                y += 1;
            }
            furthest.set(diagonal, x);
            if (x >= leftLength && y >= rightLength) {
                return (leftLength + rightLength - distance) / 2;
            }
        }
    }
    return 0;
}

function getLineEditScript(
    left: readonly string[],
    right: readonly string[],
    budget: ReviewRemediationLineComparisonBudget
): ReviewRemediationEditAtom[] | null {
    const maxDistance = left.length + right.length;
    let furthest = new Map<number, number>([[1, 0]]);
    const trace: Array<Map<number, number>> = [];
    for (let distance = 0; distance <= maxDistance; distance += 1) {
        const current = new Map<number, number>();
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            if (!consumeLineComparisonWork(budget)) {
                return null;
            }
            const down = furthest.get(diagonal + 1) ?? -1;
            const rightward = (furthest.get(diagonal - 1) ?? -1) + 1;
            let x = diagonal === -distance || (diagonal !== distance && down > rightward)
                ? down
                : rightward;
            if (x < 0) {
                x = 0;
            }
            let y = x - diagonal;
            while (x < left.length && y < right.length && left[x] === right[y]) {
                if (!consumeLineComparisonWork(budget)) {
                    return null;
                }
                x += 1;
                y += 1;
            }
            current.set(diagonal, x);
            if (x >= left.length && y >= right.length) {
                trace.push(current);
                return backtrackLineEditScript(trace, left.length, right.length);
            }
        }
        trace.push(current);
        furthest = current;
    }
    return [];
}

function backtrackLineEditScript(
    trace: readonly Map<number, number>[],
    leftLength: number,
    rightLength: number
): ReviewRemediationEditAtom[] {
    const reversed: ReviewRemediationEditAtom[] = [];
    let x = leftLength;
    let y = rightLength;
    for (let step = trace.length - 1; step >= 0; step -= 1) {
        if (step === 0) {
            while (x > 0 && y > 0) {
                x -= 1;
                y -= 1;
                reversed.push({ operation: 'context', baselineIndex: x, currentIndex: y });
            }
            break;
        }
        const previous = trace[step - 1];
        const diagonal = x - y;
        const previousDiagonal = diagonal === -step || (
            diagonal !== step
            && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1)
        )
            ? diagonal + 1
            : diagonal - 1;
        const previousX = previous.get(previousDiagonal) ?? 0;
        const previousY = previousX - previousDiagonal;
        while (x > previousX && y > previousY) {
            x -= 1;
            y -= 1;
            reversed.push({ operation: 'context', baselineIndex: x, currentIndex: y });
        }
        if (x === previousX) {
            y -= 1;
            reversed.push({ operation: 'addition', baselineIndex: null, currentIndex: y });
        } else {
            x -= 1;
            reversed.push({ operation: 'deletion', baselineIndex: x, currentIndex: null });
        }
    }
    return reversed.reverse();
}

export function buildReviewRemediationLineDelta(
    baseline: ReviewRemediationDeltaBaseEntry,
    current: ReviewRemediationDeltaBaseEntry,
    budget: ReviewRemediationLineComparisonBudget
): ReviewRemediationLineDelta {
    if (
        !baseline.line_hashes
        || !current.line_hashes
        || !baseline.redacted_lines
        || !current.redacted_lines
    ) {
        return {
            additions: null,
            deletions: null,
            changedLines: null,
            unavailableReason: `line evidence unavailable (baseline=${baseline.line_analysis}, current=${current.line_analysis})`,
            readableLines: null
        };
    }
    const editScript = getLineEditScript(baseline.line_hashes, current.line_hashes, budget);
    if (editScript === null) {
        return {
            additions: null,
            deletions: null,
            changedLines: null,
            unavailableReason: `line comparison exceeded ${REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS} work units`,
            readableLines: null
        };
    }
    const additions = editScript.filter((entry) => entry.operation === 'addition').length;
    const deletions = editScript.filter((entry) => entry.operation === 'deletion').length;
    const readableLines = editScript.map((entry): ReviewRemediationReadableDiffLine => {
        const sourceIndex = entry.operation === 'addition' ? entry.currentIndex : entry.baselineIndex;
        const sourceHashes = entry.operation === 'addition' ? current.line_hashes! : baseline.line_hashes!;
        const sourceLines = entry.operation === 'addition' ? current.redacted_lines! : baseline.redacted_lines!;
        return {
            operation: entry.operation,
            baseline_line: entry.baselineIndex === null ? null : entry.baselineIndex + 1,
            current_line: entry.currentIndex === null ? null : entry.currentIndex + 1,
            segment_index: 1,
            segment_count: 1,
            text: sourceLines[sourceIndex ?? 0] ?? '',
            source_line_sha256: sourceHashes[sourceIndex ?? 0] ?? sha256Text('')
        };
    });
    return {
        additions,
        deletions,
        changedLines: additions + deletions,
        unavailableReason: null,
        readableLines
    };
}

function splitUtf8Text(value: string, maxBytes: number): string[] {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
        return [value];
    }
    const chunks: string[] = [];
    let chunk = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (chunk && bytes + characterBytes > maxBytes) {
            chunks.push(chunk);
            chunk = '';
            bytes = 0;
        }
        chunk += character;
        bytes += characterBytes;
    }
    if (chunk || chunks.length === 0) {
        chunks.push(chunk);
    }
    return chunks;
}

export function buildReviewRemediationReadableDiffEvidence(
    files: readonly { path: string; lines: readonly ReviewRemediationReadableDiffLine[] }[]
): ReviewRemediationReadableDiffEvidence {
    const rawPages: Array<{ path: string; lines: ReviewRemediationReadableDiffLine[]; utf8_bytes: number }> = [];
    for (const file of files) {
        let pageLines: ReviewRemediationReadableDiffLine[] = [];
        let pageBytes = 0;
        const flush = (): void => {
            if (pageLines.length === 0) return;
            rawPages.push({ path: file.path, lines: pageLines, utf8_bytes: pageBytes });
            pageLines = [];
            pageBytes = 0;
        };
        for (const line of file.lines) {
            const chunks = splitUtf8Text(line.text, REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES);
            for (const [index, chunk] of chunks.entries()) {
                countNextStepWork('visit:review-remediation-readable-diff:event:297');
                const chunkBytes = Buffer.byteLength(chunk, 'utf8');
                if (pageLines.length > 0 && pageBytes + chunkBytes > REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES) {
                    flush();
                }
                pageLines.push({
                    ...line,
                    segment_index: index + 1,
                    segment_count: chunks.length,
                    text: chunk
                });
                pageBytes += chunkBytes;
            }
        }
        flush();
    }
    const pageCount = rawPages.length;
    const pages = rawPages.map((page, index): ReviewRemediationReadableDiffPage => {
        const pageWithoutHash = {
            page_number: index + 1,
            page_count: pageCount,
            path: page.path,
            lines: page.lines,
            utf8_bytes: page.utf8_bytes
        };
        return {
            ...pageWithoutHash,
            page_sha256: sha256ReviewRemediationReadableDiffPayload(pageWithoutHash)
        };
    });
    const evidenceWithoutHash = {
        schema_version: 1 as const,
        format: 'redacted_line_operations_v1' as const,
        page_max_bytes: REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES,
        page_count: pageCount,
        pages
    };
    return {
        ...evidenceWithoutHash,
        evidence_sha256: sha256ReviewRemediationReadableDiffPayload(evidenceWithoutHash)
    };
}
