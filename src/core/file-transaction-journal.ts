import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_TRANSACTION_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSACTION_JOURNAL_BYTES = 64 * 1024 * 1024;

export interface FileTransactionEntry {
    id: string;
    before: string | null;
    before_sha256: string | null;
    published_sha256: string[];
    mode: number | null;
}

export interface FileTransactionJournal {
    schema_version: 1;
    root: string;
    phase: 'prepared' | 'committed';
    entries: FileTransactionEntry[];
}

export function hashTransactionBytes(bytes: Buffer | null): string | null {
    return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

export function assertTransactionPath(root: string, filePath: string): void {
    const relative = path.relative(root, path.resolve(filePath));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error('Transaction path is outside its configured root.');
    }
    let current = root;
    for (const component of relative.split(path.sep)) {
        current = path.join(current, component);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || (current !== filePath && !stat.isDirectory())
                || (current === filePath && (!stat.isFile() || stat.nlink !== 1))) {
                throw new Error(`Unsafe transaction path: ${current}`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
}

export function readTransactionBytes(root: string, filePath: string, limit = MAX_TRANSACTION_FILE_BYTES): Buffer | null {
    assertTransactionPath(root, filePath);
    let descriptor: number;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid or oversized transaction file.');
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
            const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (count === 0) throw new Error('Transaction file changed while reading.');
            offset += count;
        }
        const after = fs.lstatSync(filePath);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            throw new Error('Transaction file identity changed while reading.');
        }
        return buffer;
    } finally {
        fs.closeSync(descriptor);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEntry(value: unknown, allowedIds: Set<string>): FileTransactionEntry {
    if (!isRecord(value) || typeof value.id !== 'string' || !allowedIds.delete(value.id)
        || !(value.before === null || typeof value.before === 'string')
        || !(value.mode === null || (Number.isInteger(value.mode) && Number(value.mode) >= 0 && Number(value.mode) <= 0o777))
        || !Array.isArray(value.published_sha256) || value.published_sha256.length === 0
        || value.published_sha256.length > 32
        || !value.published_sha256.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
        throw new Error('Invalid transaction journal entry.');
    }
    const bytes = value.before === null ? null : Buffer.from(value.before, 'base64');
    if ((bytes && (bytes.length > MAX_TRANSACTION_FILE_BYTES || bytes.toString('base64') !== value.before))
        || hashTransactionBytes(bytes) !== value.before_sha256) {
        throw new Error('Transaction journal preimage hash mismatch.');
    }
    return value as unknown as FileTransactionEntry;
}

export function readFileTransactionJournal(root: string, journalPath: string, allowedIds: string[]): FileTransactionJournal | null {
    const bytes = readTransactionBytes(root, journalPath, MAX_TRANSACTION_JOURNAL_BYTES);
    if (bytes === null) return null;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || value.schema_version !== 1 || value.root !== root
        || !['prepared', 'committed'].includes(String(value.phase)) || !Array.isArray(value.entries)
        || value.entries.length > allowedIds.length) throw new Error('Invalid transaction journal.');
    const remaining = new Set(allowedIds);
    return {
        schema_version: 1, root, phase: value.phase as FileTransactionJournal['phase'],
        entries: value.entries.map((entry) => parseEntry(entry, remaining))
    };
}
