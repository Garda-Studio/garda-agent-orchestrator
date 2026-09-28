import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { statFileIdentitySync } from './file-stat';

const FILE_HASH_BUFFER_BYTES = 64 * 1024;

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.nlink === right.nlink
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function sameExpectedFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.nlink === right.nlink
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

/**
 * Build a lowercase SHA-256 digest for a string-compatible value.
 */
export function stringSha256(value: unknown): string | null {
    if (value == null) return null;
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').toLowerCase();
}

/**
 * Build a lowercase SHA-256 digest for a regular file.
 */
export function fileSha256(filePath: string, expectedStat?: fs.Stats): string | null {
    if (!filePath) return null;
    let descriptor: number | null = null;
    try {
        const expectedPath = fs.statSync(filePath);
        if (expectedStat && !sameExpectedFileIdentity(expectedStat, expectedPath)) {
            if (process.platform !== 'win32' || expectedPath.dev !== 0 || expectedStat.dev === 0
                || !sameExpectedFileIdentity(expectedStat, statFileIdentitySync(filePath))) return null;
        }
        const pathBefore = statFileIdentitySync(filePath, { bigint: true });
        if (!pathBefore.isFile()) return null;

        descriptor = fs.openSync(filePath, 'r');
        const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
        if (!descriptorBefore.isFile() || !sameFileIdentity(pathBefore, descriptorBefore)) return null;

        const digest = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES);
        let totalBytesRead = 0n;
        while (true) {
            const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            digest.update(buffer.subarray(0, bytesRead));
            totalBytesRead += BigInt(bytesRead);
        }

        const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
        const pathAfter = statFileIdentitySync(filePath, { bigint: true });
        if (
            totalBytesRead !== descriptorBefore.size
            || !sameFileIdentity(descriptorBefore, descriptorAfter)
            || !sameFileIdentity(descriptorAfter, pathAfter)
        ) {
            return null;
        }
        return digest.digest('hex').toLowerCase();
    } catch {
        return null;
    } finally {
        if (descriptor !== null) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Descriptor cleanup is best-effort after hashing has completed.
            }
        }
    }
}
