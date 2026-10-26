import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { runGit } from '../../core/git-helpers';
import { readNativeRealpath } from '../../core/paths';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { readInvocationPathObservation, readInvocationFileContent, observedInvocationValue } from '../../core/invocation-file-observation';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../gate-runtime/task-events-locking';
import { countNextStepWork } from '../../core/next-step-measurement';

export const CLOSED_REVIEW_NAVIGATION_LIMIT = 256 * 1024;
export const CLOSED_REVIEW_STATE_LIMIT = 16 * 1024 * 1024;
export const closedReviewDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const isClosedReviewDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export interface ClosedReviewAuthentication {
    repoRealpath: string;
    gitDirectoryRealpath: string;
    workspaceSha256: string;
    key: Buffer;
}

/** Reads once through Q2 on navigation; native bounded reader on producing gates. */
export function readClosedReviewBytes(root: string, file: string, limit: number): Buffer | null {
    bindContainedDestination(root, file);
    const observation = readInvocationPathObservation(file);
    if (!observation) return readTransactionBytes(root, file, limit);
    let stat: fs.Stats;
    try { stat = observedInvocationValue(observation.stat); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
        throw new Error('Invalid review history input kind/size.');
    const content = readInvocationFileContent(file, limit);
    if (!content || content.size > limit) throw new Error('Invalid review history input.');
    const bytes = content.copyBytes();
    countNextStepWork('visit:closed-review-summary:byte-copy', bytes.length);
    return bytes;
}

/** Same worktree-local key ownership checks as parent-audit; never creates from a reader. */
export function resolveClosedReviewAuthentication(repoRoot: string, create: boolean): ClosedReviewAuthentication {
    const repoRealpath = readNativeRealpath(repoRoot);
    const git = path.join(repoRealpath, '.git');
    readInvocationPathObservation(repoRoot);
    const gitObservation = readInvocationPathObservation(git);
    const stat = gitObservation ? observedInvocationValue(gitObservation.stat) : fs.lstatSync(git);
    if (stat.isSymbolicLink()) throw new Error('Review history rejects symbolic Git metadata.');
    const pointerBytes = stat.isFile() ? readClosedReviewBytes(repoRealpath, git, 16 * 1024) : null;
    const pointer = pointerBytes?.toString('utf8').trim().match(/^gitdir:\s*(.+)$/u);
    const directory = stat.isDirectory() ? git : pointer ? path.resolve(repoRealpath, pointer[1]) : '';
    if (!directory) throw new Error('Review history requires a native Git workspace.');
    const gitDirectoryRealpath = readNativeRealpath(directory);
    const keyPath = path.join(gitDirectoryRealpath, 'garda-private/review-history-key');
    bindContainedDestination(gitDirectoryRealpath, keyPath);
    if (create && !fs.existsSync(keyPath)) {
        if (Object.keys(process.env).some(name => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_CONFIG(?:_|$))/iu.test(name)))
            throw new Error('Review history key creation rejects Git environment overrides.');
        const options = { timeoutMs: 10000, maxBuffer: 65536 };
        if (readNativeRealpath(runGit(repoRealpath, ['rev-parse', '--show-toplevel'], options).trim()) !== repoRealpath
            || readNativeRealpath(runGit(repoRealpath, ['rev-parse', '--absolute-git-dir'], options).trim()) !== gitDirectoryRealpath)
            throw new Error('Review history key destination is not the native workspace.');
        ensureContainedDirectory(gitDirectoryRealpath, path.dirname(keyPath));
        const { handle } = acquireFilesystemLock(keyPath + '.lock', { ownerLabel: 'review-history-key', requireKnownDeadOwner: true });
        try {
            if (!fs.existsSync(keyPath)) {
                writeContainedFile(gitDirectoryRealpath, keyPath, randomBytes(32).toString('hex') + '\n');
                fs.chmodSync(keyPath, 0o600);
            }
        } finally { releaseFilesystemLock(handle); }
    }
    const keyText = readClosedReviewBytes(gitDirectoryRealpath, keyPath, 128)?.toString('utf8').trim();
    if (!isClosedReviewDigest(keyText)) throw new Error('Review history native authentication key is missing or invalid.');
    const rootObservation = readInvocationPathObservation(repoRealpath);
    const identity = rootObservation ? observedInvocationValue(rootObservation.identity) : lstatFileIdentitySync(repoRealpath, { bigint: true });
    const normalize = (value: string) => process.platform === 'win32' ? value.replace(/\\/gu, '/').toLowerCase() : value;
    const workspaceSha256 = closedReviewDigest(JSON.stringify([normalize(repoRealpath), normalize(gitDirectoryRealpath),
        String(identity.dev), String(identity.ino), String(identity.birthtimeNs)]));
    return { repoRealpath, gitDirectoryRealpath, workspaceSha256, key: Buffer.from(keyText, 'hex') };
}

interface Envelope { schema_version: 1; kind: 'state' | 'navigation' | 'cadence'; workspace_sha256: string; payload: string; hmac_sha256: string; }
function mac(auth: ClosedReviewAuthentication, kind: Envelope['kind'], payload: string): string {
    return createHmac('sha256', auth.key).update(JSON.stringify(['garda.closed-review-history.v1', kind, auth.workspaceSha256, payload])).digest('hex');
}
export function encodeClosedReviewEnvelope(auth: ClosedReviewAuthentication, kind: Envelope['kind'], value: unknown): Buffer {
    const payload = JSON.stringify(value);
    return Buffer.from(JSON.stringify({ schema_version: 1, kind, workspace_sha256: auth.workspaceSha256, payload,
        hmac_sha256: mac(auth, kind, payload) } satisfies Envelope) + '\n');
}
function parseCounted(text: string): unknown {
    countNextStepWork('parse:closed-review-summary:bytes', Buffer.byteLength(text));
    return JSON.parse(text, (_key, value: unknown) => {
        countNextStepWork('visit:closed-review-summary:parsed-value'); return value;
    }) as unknown;
}
export function decodeClosedReviewEnvelope(auth: ClosedReviewAuthentication, kind: Envelope['kind'], bytes: Buffer): unknown {
    const value = parseCounted(bytes.toString('utf8')) as Partial<Envelope> | null;
    if (!value || value.schema_version !== 1 || value.kind !== kind || value.workspace_sha256 !== auth.workspaceSha256
        || typeof value.payload !== 'string' || !isClosedReviewDigest(value.hmac_sha256)) throw new Error('Invalid review history envelope.');
    const expected = mac(auth, kind, value.payload);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value.hmac_sha256, 'hex')))
        throw new Error('Review history native authentication failed.');
    return parseCounted(value.payload);
}
