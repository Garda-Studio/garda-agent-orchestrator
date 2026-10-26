import { isInvocationReadObservationActive } from '../core/invocation-read-observation';
import { fileSha256 as observedFileSha256 } from '../core/file-hashing';
import { countNextStepWork } from '../core/next-step-measurement';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * SHA-256 hash of a UTF-8 string. Returns null if value is null/undefined.
 */
export function stringSha256(value: unknown): string | null {
    if (value == null) {
        return null;
    }
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').toLowerCase();
}

/**
 * SHA-256 hash of a file's raw bytes. Returns null if file missing/unreadable.
 */
export function fileSha256(filePath: string): string | null {
    if (!filePath) {
        return null;
    }
    if (isInvocationReadObservationActive()) return observedFileSha256(filePath);
    countNextStepWork('file_hash:' + filePath);
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
    } catch {
        return null;
    }
}

