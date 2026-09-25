import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const BLOCK_BYTES = 512;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;

export interface PackedFile {
    path: string;
    size: number;
    sha256: string;
    mode: number;
    content: Buffer;
}

export interface PackedTarball {
    sha256: string;
    files: PackedFile[];
}

function headerText(header: Buffer, start: number, length: number): string {
    return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
}

function headerNumber(header: Buffer, start: number, length: number, label: string): number {
    const field = headerText(header, start, length).trim();
    if (!/^[0-7]+$/u.test(field)) {
        throw new Error(`Packed tar ${label} is not an octal number.`);
    }
    const value = Number.parseInt(field, 8);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Packed tar ${label} exceeds safe integer bounds.`);
    }
    return value;
}

function parsePax(data: Buffer): Record<string, string> {
    const values: Record<string, string> = {};
    for (let offset = 0; offset < data.length;) {
        const separator = data.indexOf(0x20, offset);
        if (separator < 0) {
            throw new Error('Packed tar has a malformed PAX record length.');
        }
        const lengthText = data.subarray(offset, separator).toString('ascii');
        if (!/^[1-9][0-9]*$/u.test(lengthText)) {
            throw new Error('Packed tar has a malformed PAX record length.');
        }
        const length = Number(lengthText);
        const end = offset + length;
        if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
            throw new Error('Packed tar has a truncated PAX record.');
        }
        const record = data.subarray(separator + 1, end - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals <= 0) {
            throw new Error('Packed tar has a malformed PAX record.');
        }
        values[record.slice(0, equals)] = record.slice(equals + 1);
        offset = end;
    }
    return values;
}

function normalizePath(value: string): string {
    if (!value.startsWith('package/')) {
        throw new Error(`Packed tar entry is outside the package root: ${value}`);
    }
    const relative = value.slice('package/'.length);
    const segments = relative.split('/');
    if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\')
        || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Packed tar contains an unsafe file path: ${value}`);
    }
    return relative;
}

export function readPackedTarball(filePath: string): PackedTarball {
    const compressedSize = fs.statSync(filePath).size;
    if (compressedSize > MAX_TARBALL_BYTES) {
        throw new Error(`Packed tarball exceeds ${MAX_TARBALL_BYTES} bytes: ${filePath}`);
    }
    const compressed = fs.readFileSync(filePath);
    const archive = zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES + MAX_FILES * BLOCK_BYTES * 3 });
    const files: PackedFile[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let totalSize = 0;
    let nextPax: Record<string, string> = {};
    while (offset + BLOCK_BYTES <= archive.length) {
        const header = archive.subarray(offset, offset + BLOCK_BYTES);
        if (header.every((byte) => byte === 0)) {
            break;
        }
        const storedChecksum = headerNumber(header, 148, 8, 'checksum');
        let checksum = 0;
        for (let index = 0; index < BLOCK_BYTES; index += 1) {
            checksum += index >= 148 && index < 156 ? 0x20 : header[index];
        }
        if (checksum !== storedChecksum) {
            throw new Error('Packed tar header checksum mismatch.');
        }
        const size = headerNumber(header, 124, 12, 'entry size');
        const mode = headerNumber(header, 100, 8, 'entry mode');
        const type = String.fromCharCode(header[156]);
        const prefix = headerText(header, 345, 155);
        const name = headerText(header, 0, 100);
        const dataStart = offset + BLOCK_BYTES;
        const dataEnd = dataStart + size;
        if (dataEnd > archive.length) {
            throw new Error('Packed tar entry exceeds the archive boundary.');
        }
        const content = archive.subarray(dataStart, dataEnd);
        offset = dataStart + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
        if (type === 'x') {
            nextPax = parsePax(content);
            continue;
        }
        const fullPath = nextPax.path || (prefix ? `${prefix}/${name}` : name);
        nextPax = {};
        if (type === '5') {
            if (fullPath !== 'package/' && fullPath !== 'package') {
                normalizePath(fullPath.replace(/\/$/u, ''));
            }
            continue;
        }
        if (type !== '0' && type !== '\0') {
            throw new Error(`Packed tar contains unsupported entry type ${JSON.stringify(type)}: ${fullPath}`);
        }
        const relativePath = normalizePath(fullPath);
        if (seen.has(relativePath)) {
            throw new Error(`Packed tar contains duplicate file path: ${relativePath}`);
        }
        seen.add(relativePath);
        totalSize += size;
        if (files.length >= MAX_FILES || totalSize > MAX_UNPACKED_BYTES) {
            throw new Error('Packed tar exceeds file-count or unpacked-byte safety bound.');
        }
        files.push({
            path: relativePath,
            size,
            sha256: crypto.createHash('sha256').update(content).digest('hex'),
            mode,
            content
        });
    }
    if (files.length === 0 || offset + BLOCK_BYTES > archive.length) {
        throw new Error('Packed tar is empty or missing its end marker.');
    }
    return { sha256: crypto.createHash('sha256').update(compressed).digest('hex'), files };
}
