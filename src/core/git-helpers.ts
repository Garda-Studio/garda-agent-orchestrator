import * as childProcess from 'node:child_process';

export interface RunGitOptions {
    allowFailure?: boolean;
    allowedFailureExitCodes?: readonly number[];
    maxBuffer?: number;
    timeoutMs?: number;
}

export interface RunGitBinaryOptions extends RunGitOptions {
    input?: string | Buffer;
}

export interface GitTreeEntry {
    mode: string;
    type: string;
    objectId: string;
}

const GIT_TREE_METADATA_MIN_BUFFER_BYTES = 1024 * 1024;
const GIT_TREE_METADATA_BYTES_PER_REQUEST = 512;
const GIT_TREE_BATCH_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

class GitCommandError extends Error {
    constructor(args: readonly string[], cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        super(`git ${args.join(' ')} failed: ${message}`, { cause });
    }
}

export function isGitExitFailure(error: unknown, exitCode: number): boolean {
    const cause = error instanceof GitCommandError ? error.cause : error;
    if (cause === null || typeof cause !== 'object') return false;
    const details = cause as { status?: unknown; signal?: unknown; code?: unknown; killed?: unknown };
    return Number.isInteger(exitCode) && exitCode > 0 && details.status === exitCode
        && (details.signal === undefined || details.signal === null)
        && (details.code === undefined || details.code === null)
        && details.killed !== true;
}

function isAllowedGitFailure(error: unknown, options: RunGitOptions): boolean {
    return options.allowFailure === true
        && (options.allowedFailureExitCodes || []).some((code) => isGitExitFailure(error, code));
}

export function runGit(repoRoot: string, args: string[], options: RunGitOptions = {}): string {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            maxBuffer: options.maxBuffer,
            timeout: options.timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (isAllowedGitFailure(error, options)) {
            return '';
        }
        throw new GitCommandError(args, error);
    }
}

export function runGitBinary(
    repoRoot: string,
    args: string[],
    options: RunGitBinaryOptions = {}
): Buffer {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            input: options.input,
            maxBuffer: options.maxBuffer,
            timeout: options.timeoutMs,
            stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (isAllowedGitFailure(error, options)) {
            return Buffer.alloc(0);
        }
        throw new GitCommandError(args, error);
    }
}

export function splitNulList(value: string | Buffer): string[] {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    return text.split('\0').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeGitTreePath(value: string): string {
    return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

interface GitBatchTreeMetadata {
    request: string;
    objectId: string;
    type: string;
    size: number;
}

function parseBatchTreeMetadata(
    output: Buffer,
    requests: readonly string[]
): Array<GitBatchTreeMetadata | null> {
    const records = output.toString('utf8').split('\0');
    if (records.at(-1) === '') {
        records.pop();
    }
    if (records.length !== requests.length) {
        throw new Error('git cat-file returned incomplete tree metadata evidence.');
    }
    return records.map((record, index) => {
        if (record.endsWith(' missing')) {
            return null;
        }
        const [objectId, type, rawSize, ...unexpected] = record.split(/\s+/u);
        const size = Number.parseInt(rawSize || '', 10);
        if (
            !/^[0-9a-f]{40,64}$/iu.test(objectId || '')
            || !/^(?:blob|commit|tag|tree)$/u.test(type || '')
            || !Number.isSafeInteger(size)
            || size < 0
            || unexpected.length > 0
        ) {
            throw new Error(`git cat-file returned malformed tree metadata for ${requests[index]}.`);
        }
        return { request: requests[index]!, objectId: objectId!, type: type!, size };
    });
}

function parseRawTreeEntries(content: Buffer, objectIdHexLength: number): Map<string, GitTreeEntry> {
    const objectIdBytes = objectIdHexLength / 2;
    const entries = new Map<string, GitTreeEntry>();
    let offset = 0;
    while (offset < content.length) {
        const modeEnd = content.indexOf(0x20, offset);
        const pathEnd = modeEnd < 0 ? -1 : content.indexOf(0x00, modeEnd + 1);
        const objectIdStart = pathEnd + 1;
        const objectIdEnd = objectIdStart + objectIdBytes;
        if (modeEnd < 0 || pathEnd < 0 || objectIdEnd > content.length) {
            throw new Error('git cat-file returned malformed raw tree evidence.');
        }
        const rawMode = content.subarray(offset, modeEnd).toString('ascii');
        if (!/^[0-7]{5,6}$/u.test(rawMode)) {
            throw new Error('git cat-file returned malformed raw tree mode evidence.');
        }
        const mode = rawMode.padStart(6, '0');
        const entryPath = content.subarray(modeEnd + 1, pathEnd).toString('utf8');
        const objectId = content.subarray(objectIdStart, objectIdEnd).toString('hex');
        const type = mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
        entries.set(entryPath, { mode, type, objectId });
        offset = objectIdEnd;
    }
    return entries;
}

function parseBatchTreeContents(
    output: Buffer,
    metadata: readonly GitBatchTreeMetadata[]
): Map<string, Map<string, GitTreeEntry>> {
    const trees = new Map<string, Map<string, GitTreeEntry>>();
    let offset = 0;
    for (const entry of metadata) {
        const headerEnd = output.indexOf(0x00, offset);
        if (headerEnd < 0) {
            throw new Error('git cat-file returned a truncated tree header.');
        }
        const [objectId, type, rawSize, ...unexpected] = output
            .subarray(offset, headerEnd)
            .toString('utf8')
            .split(/\s+/u);
        const size = Number.parseInt(rawSize || '', 10);
        if (
            objectId !== entry.objectId
            || type !== 'tree'
            || size !== entry.size
            || unexpected.length > 0
        ) {
            throw new Error('git cat-file returned unexpected tree content metadata.');
        }
        const contentStart = headerEnd + 1;
        const contentEnd = contentStart + size;
        if (contentEnd >= output.length || output[contentEnd] !== 0x00) {
            throw new Error('git cat-file returned truncated tree content.');
        }
        trees.set(
            entry.request,
            parseRawTreeEntries(output.subarray(contentStart, contentEnd), entry.objectId.length)
        );
        offset = contentEnd + 1;
    }
    if (offset !== output.length) {
        throw new Error('git cat-file returned unexpected trailing tree content.');
    }
    return trees;
}

export function readGitTreeEntriesForPaths(
    repoRoot: string,
    treeish: string,
    paths: Iterable<string>
): Map<string, GitTreeEntry> {
    const wantedPaths = new Set(
        [...paths]
            .map(normalizeGitTreePath)
            .filter(Boolean)
    );
    if (wantedPaths.size === 0) {
        return new Map();
    }

    const pathsByParent = new Map<string, Map<string, string>>();
    for (const relativePath of [...wantedPaths].sort()) {
        const separator = relativePath.lastIndexOf('/');
        const parentPath = separator < 0 ? '' : relativePath.slice(0, separator);
        const basename = separator < 0 ? relativePath : relativePath.slice(separator + 1);
        const children = pathsByParent.get(parentPath) || new Map<string, string>();
        children.set(basename, relativePath);
        pathsByParent.set(parentPath, children);
    }
    const parentRequests = [...pathsByParent.keys()]
        .sort()
        .map((parentPath) => `${treeish}:${parentPath}`);
    const metadataRequests = [`${treeish}^{tree}`, ...parentRequests];
    const requiredMetadataBytes = metadataRequests.reduce(
        (total, request) => total + Buffer.byteLength(request, 'utf8') + GIT_TREE_METADATA_BYTES_PER_REQUEST,
        0
    );
    if (!Number.isSafeInteger(requiredMetadataBytes)
        || requiredMetadataBytes > GIT_TREE_BATCH_MAX_BUFFER_BYTES) {
        throw new Error('selected tree metadata evidence exceeds the bounded Git batch buffer.');
    }
    const metadataBuffer = Math.max(
        GIT_TREE_METADATA_MIN_BUFFER_BYTES,
        requiredMetadataBytes
    );
    const metadata = parseBatchTreeMetadata(
        runGitBinary(
            repoRoot,
            ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '-Z'],
            {
                input: Buffer.from(`${metadataRequests.join('\0')}\0`, 'utf8'),
                maxBuffer: metadataBuffer
            }
        ),
        metadataRequests
    );
    if (!metadata[0] || metadata[0].type !== 'tree') {
        throw new Error(`git treeish does not resolve to a tree: ${treeish}`);
    }
    const parentMetadata = metadata.slice(1).filter(
        (entry): entry is GitBatchTreeMetadata => entry !== null && entry.type === 'tree'
    );
    const requiredContentBytes = parentMetadata.reduce(
        (total, entry) => total + entry.size + entry.objectId.length + 32,
        0
    );
    if (!Number.isSafeInteger(requiredContentBytes) || requiredContentBytes > GIT_TREE_BATCH_MAX_BUFFER_BYTES) {
        throw new Error('selected parent tree evidence exceeds the bounded Git batch buffer.');
    }
    const trees = parentMetadata.length === 0
        ? new Map<string, Map<string, GitTreeEntry>>()
        : parseBatchTreeContents(
            runGitBinary(
                repoRoot,
                ['cat-file', '--batch', '-Z'],
                {
                    input: Buffer.from(`${parentMetadata.map((entry) => entry.request).join('\0')}\0`, 'utf8'),
                    maxBuffer: Math.max(GIT_TREE_METADATA_MIN_BUFFER_BYTES, requiredContentBytes)
                }
            ),
            parentMetadata
        );
    const entries = new Map<string, GitTreeEntry>();
    for (const [parentPath, children] of pathsByParent) {
        const parentEntries = trees.get(`${treeish}:${parentPath}`);
        if (!parentEntries) {
            continue;
        }
        for (const [basename, relativePath] of children) {
            const entry = parentEntries.get(basename);
            if (entry) {
                entries.set(relativePath, entry);
            }
        }
    }
    return entries;
}
