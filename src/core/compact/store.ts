import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CompactStore, containedDirectory, openCompactFile, withCompactStore } from './store-paths';
import { displayCompactText, COMPACT_METADATA_BYTES, DEFAULT_COMPACT_SETTINGS } from './contract';
import type { CompactManifest, CompactStream } from './capture';

export { CompactCapture } from './capture';
export { withCompactStore } from './store-paths';

export interface CompactReadOptions {
    taskId: string; ref: string; stream: CompactStream; offset?: number; tail?: boolean; query?: string;
}

export interface CompactReadResult {
    text: string; nextOffset: number | null; complete: boolean; bytes: number; scannedBytes: number;
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

function searchPage(fd: number, start: number, size: number, query: string): { text: string; end: number } {
    const needle = Buffer.from(query);
    if (!needle.length || needle.length > 256) throw new Error('Search requires 1..256 UTF-8 bytes.');
    let offset = start;
    let output = '';
    let matches = 0;
    const deadline = Math.min(size, start + 1024 * 1024);
    const buffer = Buffer.alloc(8192);
    while (offset < deadline && matches < 20 && output.length < 5000) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!count) throw new Error('Compact stream changed during search.');
        const chunk = buffer.subarray(0, count);
        let index = 0;
        while ((index = chunk.indexOf(needle, index)) >= 0) {
            const excerpt = chunk.subarray(Math.max(0, index - 60), Math.min(count, index + needle.length + 60));
            output += `byte ${offset + index}: ${displayCompactText(excerpt.toString('utf8')).replace(/\n/g, '\\n')}\n`;
            matches++;
            index += needle.length;
            if (matches >= 20 || output.length >= 5000) return { text: output, end: offset + index };
        }
        offset += count === size - offset ? count : Math.max(1, count - needle.length + 1);
    }
    return { text: output || 'No matches in scanned bytes.\n', end: offset };
}

export async function readCompactOutput(repoRoot: string, options: CompactReadOptions): Promise<CompactReadResult> {
    if (!['stdout', 'stderr'].includes(options.stream)) throw new Error('Unknown compact stream.');
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw new Error('Invalid byte offset.');
    return withCompactStore(repoRoot, store => {
        const { dir, manifest } = readManifest(store, options);
        const fd = openCompactFile(path.join(dir, `${options.stream}.log`), fs.constants.O_RDONLY);
        try {
            const size = verifyStream(fd, manifest, options.stream);
            const start = options.tail ? Math.max(0, size - 1024) : Math.min(options.offset || 0, size);
            let text: string;
            let end: number;
            if (options.query !== undefined) ({ text, end } = searchPage(fd, start, size, options.query));
            else {
                const buffer = Buffer.alloc(Math.min(1024, size - start));
                const count = fs.readSync(fd, buffer, 0, buffer.length, start);
                text = displayCompactText(buffer.subarray(0, count).toString('utf8'));
                end = start + count;
            }
            return { text, nextOffset: end < size ? end : null, complete: manifest.complete, bytes: size, scannedBytes: end - start };
        } finally { fs.closeSync(fd); }
    });
}

function deleteTaskCache(store: CompactStore, taskId: string): void {
    const dir = store.taskPath(taskId);
    store.usage(taskId);
    for (const run of fs.readdirSync(dir)) {
        const runDir = store.runPath(taskId, run);
        for (const name of fs.readdirSync(runDir)) {
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
        const deadline = Date.now() + 2000;
        for (const taskId of fs.readdirSync(store.root)) {
            if (Date.now() > deadline) throw new Error('Compact cleanup budget exhausted; remaining files will be retried.');
            const eligible = typeof completed === 'function' ? completed() : completed;
            if (!eligible.has(taskId)) continue;
            deleteTaskCache(store, taskId);
            removed.push(taskId);
        }
        return removed;
    });
}
