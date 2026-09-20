import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ensureTrailingLineEnding, normalizeLineEndings } from './line-endings';

export interface WriteTextFileOptions {
    newline?: string;
    trailingNewline?: boolean;
}

export interface AtomicWriteFileOptions {
    encoding?: BufferEncoding;
    fsync?: boolean;
}

const TRANSIENT_ATOMIC_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;

interface ExistingFileMetadata {
    mode?: number;
    uid?: number;
    gid?: number;
}

export function ensureDirectory(directoryPath: string): string {
    fs.mkdirSync(directoryPath, { recursive: true });
    return directoryPath;
}

export function pathExists(targetPath: string): boolean {
    return fs.existsSync(targetPath);
}

export function readTextFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

function createAtomicTempPath(filePath: string): string {
    const directoryPath = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const nonce = crypto.randomBytes(8).toString('hex');
    return path.join(directoryPath, `.${fileName}.tmp-${process.pid}-${Date.now()}-${nonce}`);
}

function closeFileDescriptor(fileDescriptor: number | undefined): void {
    if (fileDescriptor === undefined) {
        return;
    }
    fs.closeSync(fileDescriptor);
}

function readExistingFileMetadata(filePath: string): ExistingFileMetadata {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile()) {
            // Atomic replacement replaces symlinks and other non-files at the target path.
            return {};
        }
        return {
            mode: stat.mode & 0o777,
            uid: stat.uid,
            gid: stat.gid
        };
    } catch {
        return {};
    }
}

function applyExistingFileMetadata(fileDescriptor: number, metadata: ExistingFileMetadata): void {
    if (typeof metadata.mode === 'number') {
        try {
            fs.fchmodSync(fileDescriptor, metadata.mode);
        } catch (error) {
            if (!isUnsupportedMetadataPreservationError(error)) {
                throw error;
            }
        }
    }
    if (typeof metadata.uid === 'number' && typeof metadata.gid === 'number') {
        try {
            fs.fchownSync(fileDescriptor, metadata.uid, metadata.gid);
        } catch {
            // Ownership preservation is best-effort for non-privileged users.
        }
    }
}

function isUnsupportedMetadataPreservationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
    return ['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code);
}

function sleepSync(milliseconds: number): void {
    if (milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function replaceFileWithTransientContentionRetry(tempPath: string, filePath: string): void {
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(tempPath, filePath);
            return;
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException | undefined)?.code || '').toUpperCase();
            if (
                !TRANSIENT_ATOMIC_RENAME_ERROR_CODES.has(code)
                || attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length
            ) {
                throw error;
            }
            sleepSync(ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]);
        }
    }
}

export function fsyncDirectoryBestEffort(directoryPath: string): void {
    if (process.platform === 'win32') {
        return;
    }
    let directoryDescriptor: number | undefined;
    try {
        directoryDescriptor = fs.openSync(directoryPath, 'r');
        fs.fsyncSync(directoryDescriptor);
    } catch {
        // Directory fsync is not portable across all filesystems.
    } finally {
        try {
            closeFileDescriptor(directoryDescriptor);
        } catch {
            // Best-effort cleanup only.
        }
    }
}

export function writeFileAtomically(
    filePath: string,
    content: string | Buffer,
    options: AtomicWriteFileOptions = {}
): string {
    const directoryPath = path.dirname(filePath);
    ensureDirectory(directoryPath);
    const metadata = readExistingFileMetadata(filePath);
    const tempPath = createAtomicTempPath(filePath);
    let fileDescriptor: number | undefined;
    try {
        fileDescriptor = fs.openSync(tempPath, 'wx', metadata.mode);
        applyExistingFileMetadata(fileDescriptor, metadata);
        if (typeof content === 'string') {
            fs.writeFileSync(fileDescriptor, content, options.encoding || 'utf8');
        } else {
            fs.writeFileSync(fileDescriptor, content);
        }
        if (options.fsync !== false) {
            fs.fsyncSync(fileDescriptor);
        }
        closeFileDescriptor(fileDescriptor);
        fileDescriptor = undefined;
        replaceFileWithTransientContentionRetry(tempPath, filePath);
        if (options.fsync !== false) {
            fsyncDirectoryBestEffort(directoryPath);
        }
        return filePath;
    } catch (error: unknown) {
        try {
            closeFileDescriptor(fileDescriptor);
        } catch {
            // Best-effort cleanup only.
        }
        try {
            fs.rmSync(tempPath, { force: true });
        } catch {
            // Best-effort cleanup only.
        }
        throw error;
    }
}

export function writeTextFileAtomically(
    filePath: string,
    content: string,
    options: WriteTextFileOptions & AtomicWriteFileOptions = {}
): string {
    const newline = options.newline || '\n';
    const trailingNewline = options.trailingNewline === true;
    let text = normalizeLineEndings(content, newline);
    if (trailingNewline) {
        text = ensureTrailingLineEnding(text, newline);
    }
    return writeFileAtomically(filePath, text, { encoding: 'utf8', fsync: options.fsync });
}

export function writeTextFile(filePath: string, content: string, options: WriteTextFileOptions = {}): string {
    const newline = options.newline || '\n';
    const trailingNewline = options.trailingNewline === true;
    const directoryPath = path.dirname(filePath);
    ensureDirectory(directoryPath);

    let text = normalizeLineEndings(content, newline);
    if (trailingNewline) {
        text = ensureTrailingLineEnding(text, newline);
    }

    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
}
