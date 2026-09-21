import * as fs from 'node:fs';
import { compactTextPage, COMPACT_TEXT_CHARS } from './contract';

export function readBytes(fd: number, start: number, count: number): Buffer {
    const buffer = Buffer.alloc(count);
    let read = 0;
    while (read < count) {
        const length = fs.readSync(fd, buffer, read, count - read, start + read);
        if (!length) throw new Error('Compact stream changed during retrieval.');
        read += length;
    }
    return buffer;
}

export function linePosition(fd: number, size: number, targetLine: number, stopOffset = size): { offset: number; line: number } {
    let line = 1;
    let offset = 0;
    while (offset < stopOffset && line < targetLine) {
        const chunk = readBytes(fd, offset, Math.min(65536, stopOffset - offset));
        for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] === 10 && ++line === targetLine) return { offset: offset + i + 1, line };
        }
        offset += chunk.length;
    }
    return { offset, line };
}

export function readTextPage(fd: number, start: number, size: number, maxBytes: number, lines?: number): { text: string; end: number } {
    // Include lookahead so a valid character split by the byte budget can be deferred intact.
    const buffer = readBytes(fd, start, Math.min(maxBytes + 4, size - start));
    let limit = Math.min(maxBytes, buffer.length);
    if (lines !== undefined) {
        let remaining = lines;
        for (let i = 0; i < limit; i++) if (buffer[i] === 10 && --remaining === 0) { limit = i + 1; break; }
    }
    const page = compactTextPage(buffer, limit);
    return { text: page.text, end: start + page.consumed };
}

export function readTailPage(fd: number, start: number, size: number): { text: string; end: number } {
    const bytes = readBytes(fd, start, size - start);
    let offset = 0;
    let page = compactTextPage(bytes, bytes.length);
    // Keep the end visible even when escaping controls exhausts the rendered-character budget.
    while (offset + page.consumed < bytes.length) {
        offset += Math.max(1, bytes.length - offset - page.consumed);
        while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
        page = compactTextPage(bytes.subarray(offset), bytes.length - offset);
    }
    return { text: page.text, end: size };
}

export function searchTextPage(fd: number, start: number, size: number, queries: string[], context: number): { text: string; end: number } {
    const needles = [...new Set(queries)].map(query => Buffer.from(query));
    if (!needles.length || needles.length > 8 || needles.some(needle => !needle.length || needle.length > 256)) throw new Error('Search requires 1..8 queries of 1..256 UTF-8 bytes.');
    const end = Math.min(size, start + 1024 * 1024);
    const contextBytes = 4096;
    const base = Math.max(0, start - contextBytes);
    const buffer = readBytes(fd, base, Math.min(size, end + contextBytes) - base);
    let cursor = start - base;
    let output = '';
    let lastShown = -1;
    let matches = 0;
    const baseLine = linePosition(fd, size, Infinity, base).line;
    while (cursor < end - base) {
        const positions = needles.map(needle => buffer.indexOf(needle, cursor)).filter(index => index >= 0 && index < end - base);
        if (!positions.length) break;
        const index = Math.min(...positions);
        const length = Math.max(...needles.filter(needle => buffer.subarray(index, index + needle.length).equals(needle)).map(needle => needle.length));
        let from = index;
        let to = index + length;
        for (let n = 0; n <= context; n++) {
            const previous = from > 0 ? buffer.lastIndexOf(10, from - 1) : -1;
            from = previous < 0 ? 0 : previous;
            const next = buffer.indexOf(10, to);
            to = next < 0 ? buffer.length : next + 1;
        }
        if (from > 0 && buffer[from] === 10) from++;
        from = Math.max(from, index - contextBytes, lastShown);
        to = Math.min(to, index + length + contextBytes);
        if (to > from) {
            const budget = COMPACT_TEXT_CHARS - output.length - 180;
            if (budget < 2048) return { text: output, end: base + cursor };
            // Reserve room for the entire match even when every preceding byte escapes to four characters.
            if (index - from > 128) from = Math.max(from, index - 128);
            // Context may start mid-character after clipping a long line.
            const boundaryFloor = Math.max(0, from - 3);
            while (from > boundaryFloor && (buffer[from] & 0xc0) === 0x80) from--;
            const line = baseLine + buffer.subarray(0, from).reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
            const excerpt = compactTextPage(buffer.subarray(from, to), to - from, budget);
            output += `byte ${base + index}; retained line ${line}; read offset ${base + from}:\n${excerpt.text}\n`;
            if (excerpt.consumed < to - from || (from > 0 && buffer[from - 1] !== 10) || (to < buffer.length && buffer[to - 1] !== 10)) output += '[context clipped; use read offset]\n';
            lastShown = from + excerpt.consumed;
        }
        cursor = index + 1;
        if (++matches >= 20) return { text: output, end: base + cursor };
    }
    return { text: output || 'No matches in scanned bytes.\n', end };
}
