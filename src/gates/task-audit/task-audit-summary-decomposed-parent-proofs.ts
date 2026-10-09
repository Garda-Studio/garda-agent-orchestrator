import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { bindContainedDestination, assertContainedDestination } from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';

const MAX_PROOF_INPUT_BYTES = 8 * 1024 * 1024;

// Byte fidelity is not native source acceptance or aggregate audit authority.
export function readParentAuditProofRecord(
    repoRoot: string, artifactPath: string, expectedSha256: string
): Record<string, unknown> {
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
        throw new Error('Parent-audit proof requires an exact SHA256 evidence binding.');
    }
    const binding = bindContainedDestination(repoRoot, artifactPath);
    const identity = binding.existing.at(-1);
    if (binding.missingAt || !identity || identity.path !== binding.path) {
        throw new Error('Parent-audit proof input is missing.');
    }
    assertContainedDestination(binding);
    const descriptor = fs.openSync(binding.path,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_PROOF_INPUT_BYTES)
            || before.dev !== identity.dev || before.ino !== identity.ino
            || before.mode !== identity.mode || before.birthtimeNs !== identity.birthtimeNs) {
            throw new Error('Parent-audit proof requires a bounded ordinary file with intact identity.');
        }
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            if (count === 0) break;
            length += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        assertContainedDestination(binding);
        if (length !== Number(before.size) || after.size !== before.size
            || after.nlink !== 1n || after.mode !== before.mode
            || after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) {
            throw new Error('Parent-audit proof changed during its bounded read.');
        }
        const content = bytes.subarray(0, length);
        if (createHash('sha256').update(content).digest('hex') !== expectedSha256) {
            throw new Error('Parent-audit proof bytes do not match their evidence binding.');
        }
        const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
        if (!isPlainRecord(record)) throw new Error('Parent-audit proof must contain a JSON record.');
        assertContainedDestination(binding);
        return record;
    } finally { fs.closeSync(descriptor); }
}
