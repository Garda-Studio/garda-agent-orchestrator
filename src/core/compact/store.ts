import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CompactStore, containedDirectory, openCompactFile, withCompactStore } from './store-paths';
import { COMPACT_METADATA_BYTES, DEFAULT_COMPACT_SETTINGS, MAX_COMPACT_SETTINGS } from './contract';
import { readCompactSettings } from './settings';
import { linePosition, readBytes, readTextPage, readTailPage, searchTextPage } from './retrieval';
import type { CompactManifest, CompactStream, CompactSource } from './capture';

export { CompactCapture } from './capture';
export { withCompactStore } from './store-paths';

export interface CompactReadOptions {
    taskId: string; ref: string; stream: CompactStream; offset?: number; tail?: boolean; query?: string;
    queries?: string[]; maxBytes?: number; fromLine?: number; lines?: number; context?: number;
}

export interface CompactReadResult {
    text: string; nextOffset: number | null; complete: boolean; bytes: number; scannedBytes: number; source?: CompactSource;
}

function readManifest(store: CompactStore, options: CompactReadOptions): { dir: string; manifest: CompactManifest } {
    let dir: string;
    try { dir = store.runPath(options.taskId, options.ref); }
    catch { throw new Error('Compact output is not retained or the reference is invalid.'); }
    const fd = openCompactFile(path.join(dir, 'manifest.json'), fs.constants.O_RDONLY);
    let manifest: CompactManifest;
    try {
        if (fs.fstatSync(fd).size > COMPACT_METADATA_BYTES) throw new Error('Oversized compact manifest.');
        manifest = JSON.parse(fs.readFileSync(fd, 'utf8')) as CompactManifest;
    } finally { fs.closeSync(fd); }
    if (manifest.version !== 1 || manifest.taskId !== options.taskId || manifest.ref !== options.ref || typeof manifest.complete !== 'boolean') throw new Error('Invalid compact manifest binding.');
    if (manifest.source !== undefined) {
        const source = manifest.source;
        if (!source || typeof source.path !== 'string' || source.path.length > 2048 || !Number.isSafeInteger(source.from) || source.from < 1
            || !Number.isSafeInteger(source.to) || source.to < source.from - 1 || typeof source.eof !== 'boolean') throw new Error('Invalid compact source metadata.');
    }
    return { dir, manifest };
}

function verifyStream(fd: number, manifest: CompactManifest, stream: CompactStream): number {
    const metadata = manifest.streams?.[stream];
    const size = fs.fstatSync(fd).size;
    if (!metadata || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || size !== metadata.bytes || size > DEFAULT_COMPACT_SETTINGS.runBytes) throw new Error('Invalid compact stream size.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < size;) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!count) throw new Error('Compact stream changed during verification.');
        hash.update(buffer.subarray(0, count));
        offset += count;
    }
    if (hash.digest('hex') !== metadata.sha256) throw new Error('Compact stream hash mismatch.');
    return size;
}

export async function readCompactOutput(repoRoot: string, options: CompactReadOptions): Promise<CompactReadResult> {
    if (!['stdout', 'stderr'].includes(options.stream)) throw new Error('Unknown compact stream.');
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw new Error('Invalid byte offset.');
    if (options.fromLine !== undefined && (!Number.isSafeInteger(options.fromLine) || options.fromLine < 1)) throw new Error('Invalid starting line.');
    if (options.lines !== undefined && (!Number.isSafeInteger(options.lines) || options.lines < 1 || options.lines > 2000)) throw new Error('Invalid line count.');
    if ((options.fromLine !== undefined && (options.offset !== undefined || options.tail)) || (options.tail && options.offset !== undefined)) throw new Error('Choose line, offset or tail positioning, not multiple modes.');
    if (options.tail && options.lines !== undefined) throw new Error('Tail uses a byte budget, not a line selection.');
    const settings = readCompactSettings(repoRoot);
    const maxBytes = options.maxBytes ?? settings.readBytes;
    const context = options.context ?? settings.searchContext;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_COMPACT_SETTINGS.readBytes) throw new Error('Read byte budget requires 256..8192.');
    if (!Number.isSafeInteger(context) || context < 0 || context > MAX_COMPACT_SETTINGS.searchContext) throw new Error('Search context requires 0..8 lines.');
    const queries = options.queries ?? (options.query === undefined ? undefined : [options.query]);
    if (queries && (options.fromLine !== undefined || options.lines !== undefined || options.tail)) throw new Error('Search uses byte offsets only.');
    return withCompactStore(repoRoot, store => {
        const { dir, manifest } = readManifest(store, options);
        const fd = openCompactFile(path.join(dir, `${options.stream}.log`), fs.constants.O_RDONLY);
        try {
            const size = verifyStream(fd, manifest, options.stream);
            let start = options.fromLine !== undefined ? linePosition(fd, size, options.fromLine).offset
                : options.tail ? Math.max(0, size - maxBytes) : Math.min(options.offset || 0, size);
            // Offset reads include the lead byte; tails skip a partial leading character to reach EOF.
            if (!queries && start > 0 && start < size) {
                if (options.tail) {
                    const boundary = readBytes(fd, start, Math.min(3, size - start));
                    for (const byte of boundary) {
                        if ((byte & 0xc0) !== 0x80) break;
                        start++;
                    }
                } else {
                    const boundary = readBytes(fd, Math.max(0, start - 3), Math.min(4, start + 1));
                    let index = boundary.length - 1;
                    while (index > 0 && (boundary[index] & 0xc0) === 0x80) { start--; index--; }
                }
            }
            const page = queries ? searchTextPage(fd, start, size, queries, context)
                : options.tail ? readTailPage(fd, start, size) : readTextPage(fd, start, size, maxBytes, options.lines);
            return { text: page.text, nextOffset: page.end < size ? page.end : null, complete: manifest.complete,
                bytes: size, scannedBytes: page.end - start, ...(manifest.source ? { source: manifest.source } : {}) };
        } finally { fs.closeSync(fd); }
    });
}

function deleteTaskCache(store: CompactStore, taskId: string, deadline: number): void {
    const dir = store.taskPath(taskId);
    for (const run of fs.readdirSync(dir)) {
        if (Date.now() > deadline) throw new Error('Compact cleanup budget exhausted; remaining files will be retried.');
        const runDir = store.runPath(taskId, run);
        for (const name of fs.readdirSync(runDir)) {
            if (Date.now() > deadline) throw new Error('Compact cleanup budget exhausted; remaining files will be retried.');
            if (!['stdout.log', 'stderr.log', 'manifest.json', 'manifest.tmp'].includes(name)) throw new Error('Unexpected compact file; cleanup declined.');
            const file = path.join(containedDirectory(dir, run), name);
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe compact cleanup target.');
            fs.unlinkSync(file);
        }
        fs.rmdirSync(runDir);
    }
    fs.rmdirSync(dir);
}

export async function cleanupCompactTasks(repoRoot: string, completed: ReadonlySet<string> | (() => ReadonlySet<string>)): Promise<string[]> {
    return withCompactStore(repoRoot, store => {
        const removed: string[] = [];
        const deadline = typeof completed === 'function' ? Date.now() + 2000 : Infinity;
        for (const taskId of fs.readdirSync(store.root)) {
            if (Date.now() > deadline) throw new Error('Compact cleanup budget exhausted; remaining files will be retried.');
            const eligible = typeof completed === 'function' ? completed() : completed;
            if (!eligible.has(taskId)) continue;
            deleteTaskCache(store, taskId, deadline);
            removed.push(taskId);
        }
        return removed;
    });
}
