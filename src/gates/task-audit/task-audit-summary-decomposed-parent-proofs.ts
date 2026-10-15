import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { bindContainedDestination, assertContainedDestination } from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';
import { runGit, runGitBinary } from '../../core/git-helpers';

const MAX_PROOF_INPUT_BYTES = 8 * 1024 * 1024;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SOURCE_GIT_OPTIONS = { maxBuffer: 64 * 1024, timeoutMs: 10000 };

export interface NativeChildGitSource {
    commitSha: string;
    treeSha: string;
    parentCommitSha: string | null;
}

function readRawSourceObjects(root: string, requests: Array<{ sha: string; type: 'commit' | 'tree' }>): Buffer[] {
    const bytes = runGitBinary(root, ['--no-replace-objects', 'cat-file', '--batch'], {
        ...SOURCE_GIT_OPTIONS, maxBuffer: MAX_PROOF_INPUT_BYTES,
        input: requests.map(item => item.sha).join('\n') + '\n'
    });
    let offset = 0;
    const objects = requests.map(({ sha, type }) => {
        const end = bytes.indexOf(10, offset);
        const header = end < 0 ? null : /^([a-f0-9]+) (commit|tree) ([0-9]+)$/u
            .exec(bytes.subarray(offset, end).toString('ascii'));
        const size = header ? Number(header[3]) : NaN, start = end + 1;
        if (!header || header[1] !== sha || header[2] !== type || !Number.isSafeInteger(size)
            || size < 0 || size > MAX_PROOF_INPUT_BYTES || start + size >= bytes.length
            || bytes[start + size] !== 10) {
            throw new Error('Git proof requires complete bounded raw object frames.');
        }
        const object = bytes.subarray(start, start + size);
        const digest = createHash(sha.length === 40 ? 'sha1' : 'sha256')
            .update(`${type} ${size}\0`).update(object).digest('hex');
        if (digest !== sha) throw new Error('Git object bytes do not match their immutable identity.');
        offset = start + size + 1;
        return object;
    });
    if (offset !== bytes.length) throw new Error('Git proof contains unexpected raw object frames.');
    return objects;
}

function verifySourceCommit(object: Buffer, row: string[], expectedTree?: string): void {
    const separator = object.indexOf('\n\n');
    const headers = object.subarray(0, separator).toString('utf8').split('\n');
    const tree = /^tree ((?:[a-f0-9]{40}|[a-f0-9]{64}))$/u.exec(headers[0])?.[1];
    let parentEnd = 1;
    while (headers[parentEnd]?.startsWith('parent ')) parentEnd++;
    const parents = headers.slice(1, parentEnd).map(line => line.slice(7));
    if (separator < 0 || !tree || headers.slice(parentEnd).some(line => /^(?:tree|parent) /u.test(line))
        || (expectedTree !== undefined && tree !== expectedTree)
        || parents.join(' ') !== row.slice(1).join(' ')) {
        throw new Error('Git commit tree or ancestry parents differ from immutable source evidence.');
    }
}

function verifyRawSourceAncestry(rows: string[][], head: string, accepted: string): void {
    const parents = new Map(rows.map(row => [row[0], row.slice(1)]));
    const pending = [head], seen = new Set<string>();
    while (pending.length) {
        const sha = pending.pop()!;
        if (sha === accepted) return;
        if (seen.has(sha)) continue;
        seen.add(sha);
        pending.push(...(parents.get(sha) || []));
    }
    throw new Error('Git raw ancestry does not connect current HEAD to accepted source.');
}

/** Git corroboration alone does not authenticate task SOURCE records or accept a parent audit. */
export function validateNativeChildGitSource(repoRoot: string, source: NativeChildGitSource): void {
    if (!source || !GIT_OBJECT_PATTERN.test(source.commitSha) || !GIT_OBJECT_PATTERN.test(source.treeSha)
        || (source.parentCommitSha !== null && !GIT_OBJECT_PATTERN.test(source.parentCommitSha))) {
        throw new Error('Git source proof requires exact commit, tree and parent object identity.');
    }
    const root = fs.realpathSync.native(repoRoot);
    const localVariables = runGit(root, ['--no-replace-objects', 'rev-parse', '--local-env-vars'], SOURCE_GIT_OPTIONS)
        .trim().split(/\r?\n/u).concat('GIT_NAMESPACE');
    const inherited = new Set(Object.keys(process.env).map(name => name.toUpperCase()));
    if (localVariables.some(name => inherited.has(name.toUpperCase()))) {
        throw new Error('Git proof rejects inherited repository environment overrides.');
    }
    const [gitRoot, grafts, head] = runGit(root, ['--no-replace-objects', 'rev-parse', '--show-toplevel',
        '--git-path', 'info/grafts', 'HEAD'], SOURCE_GIT_OPTIONS).trim().split(/\r?\n/u);
    if (!gitRoot || fs.realpathSync.native(gitRoot) !== root) {
        throw new Error('Git proof requires the exact workspace Git root.');
    }
    if (!grafts || fs.existsSync(path.resolve(root, grafts))) throw new Error('Git proof rejects graft ancestry.');
    if (!head || !GIT_OBJECT_PATTERN.test(head)
        || [source.commitSha, source.treeSha, source.parentCommitSha].some(sha => sha !== null && sha.length !== head.length)) {
        throw new Error('Git source object identity does not match the repository format.');
    }
    const ancestry = runGit(root, ['--no-replace-objects', 'rev-list', '--parents', '--ancestry-path', '--full-history',
        `${source.commitSha}..${head}`], SOURCE_GIT_OPTIONS).trim();
    const rows = [[source.commitSha, ...(source.parentCommitSha === null ? [] : [source.parentCommitSha])],
        ...ancestry.split('\n').filter(Boolean).map(line => line.trim().split(' '))];
    if (rows.some(row => row.some(sha => !GIT_OBJECT_PATTERN.test(sha)))) {
        throw new Error('Git ancestry contains invalid object identity.');
    }
    const objects = readRawSourceObjects(root, [...rows.map(row => ({ sha: row[0], type: 'commit' as const })),
        { sha: source.treeSha, type: 'tree' }]);
    rows.forEach((row, index) => verifySourceCommit(objects[index], row, index === 0 ? source.treeSha : undefined));
    verifyRawSourceAncestry(rows, head, source.commitSha);
    if (runGit(root, ['--no-replace-objects', 'rev-parse', 'HEAD'], SOURCE_GIT_OPTIONS).trim() !== head) {
        throw new Error('Git HEAD changed during source proof verification.');
    }
}

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
