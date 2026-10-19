import { ensureTrailingLineEnding, normalizeLineEndings } from './line-endings';

export interface ManagedBlockOptions {
    startMarker: string;
    endMarker: string;
    blockLines?: string[];
    newline?: string;
}

export interface ManagedSpan {
    start: number;
    end: number;
}

export type OwnershipKind = 'managed' | 'user';

export interface OwnershipRegion {
    kind: OwnershipKind;
    start: number;
    end: number;
    text: string;
}

export function buildManagedBlock(startMarker: string, endMarker: string, blockLines: string | string[], newline: string = '\n'): string {
    const lines = Array.isArray(blockLines) ? blockLines.map((line) => String(line)) : [String(blockLines)];
    return [startMarker, ...lines, endMarker].join(newline);
}

/**
 * Find the span covering `startMarker...endMarker` inside `text`.
 * Returns `{ start, end }` indices or `undefined` when the markers are absent.
 * The span includes an optional leading `\n` before the start marker and an
 * optional trailing `\n` after the end marker so callers can slice cleanly.
 */
export function findManagedSpan(text: string, startMarker: string, endMarker: string, includePeripheralNewlines: boolean): ManagedSpan | undefined {
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return undefined;

    const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx === -1) return undefined;

    let spanStart = startIdx;
    let spanEnd = endIdx + endMarker.length;

    if (includePeripheralNewlines) {
        if (spanStart > 0 && text[spanStart - 1] === '\n') spanStart--;
        if (spanEnd < text.length && text[spanEnd] === '\n') spanEnd++;
    }

    return { start: spanStart, end: spanEnd };
}

/**
 * Extract the text inside a managed block (between start and end markers inclusive).
 * Returns `null` when no managed block is found.
 */
export function extractManagedContent(text: string, startMarker: string, endMarker: string): string | null {
    const span = findManagedSpan(text, startMarker, endMarker, false);
    if (!span) return null;
    return text.slice(span.start, span.end);
}

/**
 * Extract the user-owned content (everything outside managed blocks).
 * Returns the concatenated user-owned portions of the text.
 */
export function extractUserContent(text: string, startMarker: string, endMarker: string): string {
    const span = findManagedSpan(text, startMarker, endMarker, false);
    if (!span) return text;
    return text.slice(0, span.start) + text.slice(span.end);
}

/**
 * Classify every region of `text` as either `managed` or `user`-owned.
 * Returns an ordered array of non-overlapping regions covering the full text.
 * Empty regions are omitted.
 */
export function classifyOwnership(text: string, startMarker: string, endMarker: string): OwnershipRegion[] {
    const regions: OwnershipRegion[] = [];
    const span = findManagedSpan(text, startMarker, endMarker, false);

    if (!span) {
        if (text.length > 0) {
            regions.push({ kind: 'user', start: 0, end: text.length, text });
        }
        return regions;
    }

    if (span.start > 0) {
        regions.push({ kind: 'user', start: 0, end: span.start, text: text.slice(0, span.start) });
    }
    regions.push({ kind: 'managed', start: span.start, end: span.end, text: text.slice(span.start, span.end) });
    if (span.end < text.length) {
        regions.push({ kind: 'user', start: span.end, end: text.length, text: text.slice(span.end) });
    }

    return regions;
}

function listMarkerIndexes(text: string, marker: string): number[] {
    const indexes: number[] = [];
    for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + marker.length)) {
        indexes.push(index);
    }
    return indexes;
}

/**
 * All managed spans for a mutation. Markers must strictly alternate start/end; an orphan, nested or
 * reversed marker makes ownership ambiguous, and rewriting would delete user text between markers.
 */
function findWellFormedManagedSpans(text: string, startMarker: string, endMarker: string): ManagedSpan[] {
    const markers = [
        ...listMarkerIndexes(text, startMarker).map(index => ({ index, kind: 'start' as const })),
        ...listMarkerIndexes(text, endMarker).map(index => ({ index, kind: 'end' as const }))
    ].sort((left, right) => left.index - right.index);
    const spans: ManagedSpan[] = [];
    for (let position = 0; position < markers.length; position += 2) {
        const start = markers[position];
        const end = markers[position + 1];
        if (start.kind !== 'start' || !end || end.kind !== 'end') {
            throw new Error(`Ambiguous managed block markers (${startMarker} ... ${endMarker}): `
                + 'markers are orphaned, nested or reversed. The file was left unchanged to preserve user text; '
                + 'restore one complete marker pair and retry.');
        }
        spans.push({ start: start.index, end: end.index + endMarker.length });
    }
    return spans;
}

function removeSpans(text: string, spans: readonly ManagedSpan[]): string {
    let result = text;
    for (const span of [...spans].sort((left, right) => right.start - left.start)) {
        const start = span.start > 0 && result[span.start - 1] === '\n' ? span.start - 1 : span.start;
        const end = span.end < result.length && result[span.end] === '\n' ? span.end + 1 : span.end;
        result = result.slice(0, start) + '\n' + result.slice(end);
    }
    return result;
}

export function upsertManagedBlock(content: string, options: ManagedBlockOptions): string {
    const newline = options.newline || '\n';
    const normalized = normalizeLineEndings(content || '', '\n');
    const block = buildManagedBlock(options.startMarker, options.endMarker, options.blockLines || [], '\n');
    let result: string;

    const [span, ...duplicates] = findWellFormedManagedSpans(normalized, options.startMarker, options.endMarker);
    if (span) {
        // Later complete pairs hold only Garda-managed content; keep exactly one current block.
        const tail = normalized.slice(span.end);
        const cleanTail = duplicates.length > 0
            ? removeSpans(tail, duplicates.map(duplicate => ({
                start: duplicate.start - span.end, end: duplicate.end - span.end
            }))).replace(/\n{3,}/g, '\n\n')
            : tail;
        result = normalized.slice(0, span.start) + block + cleanTail;
    } else if (normalized.trim().length === 0) {
        result = block;
    } else {
        result = ensureTrailingLineEnding(normalized, '\n') + block;
    }

    return ensureTrailingLineEnding(normalizeLineEndings(result, newline), newline);
}

export function removeManagedBlock(content: string, options: ManagedBlockOptions): string {
    const newline = options.newline || '\n';
    const normalized = normalizeLineEndings(content || '', '\n');

    const spans = findWellFormedManagedSpans(normalized, options.startMarker, options.endMarker);
    if (spans.length === 0) return normalizeLineEndings(normalized, newline);

    const result = removeSpans(normalized, spans)
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n/, '');

    return normalizeLineEndings(result, newline);
}

