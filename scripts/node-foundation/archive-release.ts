import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from './build';

export type ReleaseArchiveKind = 'source' | 'evidence';

export interface ReleaseArchiveEntry {
    readonly relativePath: string;
    readonly size: number;
    readonly sha256: string;
    readonly type: 'file' | 'symlink';
    readonly identity: ReleaseArchiveIdentity;
    readonly linkTarget?: string;
}

export interface ReleaseArchiveIdentity {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
}

export interface ReleaseArchivePlan {
    kind: ReleaseArchiveKind;
    repoRoot: string;
    outputPath: string;
    entries: readonly ReleaseArchiveEntry[];
}

const DEFAULT_OUTPUT_DIR = 'release-archives';
const MANIFEST_ENTRY_PATH = 'ARCHIVE-MANIFEST.json';
const SOURCE_EXCLUDED_PREFIXES = Object.freeze([
    '.node-build/',
    '.scripts-build/',
    '.scripts-build.lock/',
    'coverage/',
    'dist/',
    'garda-agent-orchestrator/runtime/',
    'node_modules/',
    'release-archives/',
    'runtime/'
]);
const EVIDENCE_INCLUDED_PREFIXES = Object.freeze([
    'garda-agent-orchestrator/runtime/manual-validation/',
    'garda-agent-orchestrator/runtime/metrics/',
    'garda-agent-orchestrator/runtime/project-memory/',
    'garda-agent-orchestrator/runtime/reports/',
    'garda-agent-orchestrator/runtime/reviews/',
    'garda-agent-orchestrator/runtime/task-events/',
    'garda-agent-orchestrator/runtime/task-ledger/'
]);
const SECRET_PATH_RE = /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|id_rsa|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|tokens?(?:\.[^/]*)?|.*\.(?:key|pem|p12|pfx))$/iu;
const SECRET_CONTENT_RES = Object.freeze([
    /(?:^|[\r\n])[\uFEFF\uFFFD]*\s*(?:export\s+)?["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/\-=]{12,}/iu,
    /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/\-=]{12,}/iu,
    /\bhttps?:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s]+/iu,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u
]);
const EVIDENCE_SECRET_SCAN_CHUNK_BYTES = 1024 * 1024;
const EVIDENCE_SECRET_SCAN_OVERLAP_BYTES = 4096;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_EVIDENCE_DIRECTORIES = 50_000;
const MAX_EVIDENCE_TRAVERSAL_NODES = 200_000;
const MAX_EVIDENCE_DIRECTORY_DEPTH = 64;
const MAX_ARCHIVE_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GIT_PATH_OUTPUT_BYTES = 64 * 1024 * 1024;
const TAR_LINK_NAME_BYTES = 100;

function normalizeRelativePath(value: string): string {
    return value.split(path.sep).join('/').replace(/^\.\//u, '');
}

function assertSafeRelativePath(relativePath: string): void {
    if (!relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
        || relativePath.includes('\\') || relativePath.includes('\0')
        || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
        || /(^|\/)[A-Za-z]:/u.test(relativePath)
        || relativePath.toLowerCase() === MANIFEST_ENTRY_PATH.toLowerCase()
        || relativePath.toLowerCase().startsWith(`${MANIFEST_ENTRY_PATH.toLowerCase()}/`)) {
        throw new Error(`Unsafe archive path: ${relativePath}`);
    }
}

function runGit(repoRoot: string, args: string[]): Buffer {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        maxBuffer: MAX_GIT_PATH_OUTPUT_BYTES,
        windowsHide: true
    });
    if (result.status !== 0 || result.error) {
        throw new Error(`git ${args.join(' ')} failed: ${String(result.error?.message || result.stderr).trim()}`);
    }
    return result.stdout;
}

export function readNulDelimitedGitPaths(output: Buffer): string[] {
    if (output.length === 0) {
        return [];
    }
    if (output[output.length - 1] !== 0) {
        throw new Error('git ls-files -z output is missing its final NUL delimiter.');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const paths: string[] = [];
    for (let start = 0; start < output.length; ) {
        const end = output.indexOf(0, start);
        if (end === start || end < 0) {
            throw new Error('git ls-files -z output contains an empty or malformed path.');
        }
        assertReleaseArchiveBudget(paths.length + 1, 0);
        paths.push(decoder.decode(output.subarray(start, end)));
        start = end + 1;
    }
    return paths;
}

function isExcludedSourcePath(relativePath: string): boolean {
    return SOURCE_EXCLUDED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function isSensitiveEvidencePath(relativePath: string): boolean {
    return SECRET_PATH_RE.test(relativePath) || relativePath === 'garda-agent-orchestrator/runtime/init-answers.json';
}

export function hasCredentialLikeContent(value: string): boolean {
    return [value, ...value.split('/')].some((part) => SECRET_CONTENT_RES.some((pattern) => pattern.test(part)));
}

function isGeneratedReviewSupportPath(relativePath: string): boolean {
    if (!relativePath.startsWith('garda-agent-orchestrator/runtime/reviews/')) {
        return false;
    }
    const basename = path.posix.basename(relativePath);
    return /-(?:review-context|role-prompt|prompt-template|output-template|evidence-manifest|scoped)(?:[.-]|$)/u.test(basename);
}

function sourceIdentity(stat: fs.Stats): ReleaseArchiveIdentity {
    return {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs
    };
}

function assertSourceIdentity(expected: ReleaseArchiveIdentity, stat: fs.Stats, relativePath: string): void {
    const current = sourceIdentity(stat);
    if (Object.keys(expected).some((key) => expected[key as keyof ReleaseArchiveIdentity] !== current[key as keyof ReleaseArchiveIdentity])) {
        throw new Error(`Archive input identity changed: ${relativePath}`);
    }
}

function hashAndScanFile(filePath: string, relativePath: string, identity: ReleaseArchiveIdentity, scanSecrets: boolean): string {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        assertSourceIdentity(identity, fs.fstatSync(descriptor), relativePath);
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(Math.min(EVIDENCE_SECRET_SCAN_CHUNK_BYTES, Math.max(identity.size, 1)));
        let position = 0;
        let separatedOverlap = '';
        let joinedOverlap = '';
        while (position < identity.size) {
            const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, identity.size - position), position);
            if (bytesRead === 0) {
                throw new Error(`Archive input changed while reading: ${relativePath}`);
            }
            position += bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
            if (scanSecrets) {
                const text = buffer.subarray(0, bytesRead).toString('utf8');
                const separated = `${separatedOverlap}${text.replace(/\0/gu, '\n')}`;
                const joined = `${joinedOverlap}${text.replace(/\0/gu, '')}`;
                if (SECRET_CONTENT_RES.some((pattern) => pattern.test(separated) || pattern.test(joined))) {
                    throw new Error(`Refusing to archive evidence file with credential-like content: ${relativePath}`);
                }
                separatedOverlap = separated.slice(-EVIDENCE_SECRET_SCAN_OVERLAP_BYTES);
                joinedOverlap = joined.slice(-EVIDENCE_SECRET_SCAN_OVERLAP_BYTES);
            }
        }
        assertSourceIdentity(identity, fs.fstatSync(descriptor), relativePath);
        assertSourceIdentity(identity, fs.lstatSync(filePath), relativePath);
        return hash.digest('hex');
    } finally {
        fs.closeSync(descriptor);
    }
}

function listTrackedSourceFiles(repoRoot: string): string[] {
    return readNulDelimitedGitPaths(runGit(repoRoot, ['ls-files', '-z']))
        .map(normalizeRelativePath)
        .filter((entry) => !isExcludedSourcePath(entry))
        .sort();
}

function isTransientEvidenceDirectory(name: string): boolean {
    return name.toLowerCase() === 'coverage' || name.toLowerCase() === 'tmp' || name.toLowerCase() === '.tmp';
}

function* listFilesUnder(rootPath: string, traversal: { directories: number; nodes: number }, depth = 0): IterableIterator<string> {
    if (!fs.existsSync(rootPath)) {
        return;
    }
    const stat = fs.lstatSync(rootPath);
    if (stat.isFile() || stat.isSymbolicLink()) {
        traversal.nodes += 1;
        if (traversal.nodes > MAX_EVIDENCE_TRAVERSAL_NODES) {
            throw new Error(`Archive evidence traversal budget exceeded: ${rootPath}`);
        }
        yield rootPath;
        return;
    }
    if (!stat.isDirectory()) {
        return;
    }
    traversal.directories += 1;
    if (traversal.directories > MAX_EVIDENCE_DIRECTORIES) {
        throw new Error(`Archive evidence directory budget exceeded: ${rootPath}`);
    }
    if (depth > MAX_EVIDENCE_DIRECTORY_DEPTH) {
        throw new Error(`Archive evidence directory depth exceeded: ${rootPath}`);
    }
    const directory = fs.opendirSync(rootPath);
    try {
        let entry: fs.Dirent | null;
        while ((entry = directory.readSync()) !== null) {
            traversal.nodes += 1;
            if (traversal.nodes > MAX_EVIDENCE_TRAVERSAL_NODES) {
                throw new Error(`Archive evidence traversal budget exceeded: ${rootPath}`);
            }
            const entryPath = path.join(rootPath, entry.name);
            if (entry.isDirectory()) {
                if (!isTransientEvidenceDirectory(entry.name)) {
                    yield* listFilesUnder(entryPath, traversal, depth + 1);
                }
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                yield entryPath;
            }
        }
    } finally {
        directory.closeSync();
    }
}

function listEvidenceFiles(repoRoot: string): string[] {
    const entries = new Set<string>();
    const traversal = { directories: 0, nodes: 0 };
    for (const prefix of EVIDENCE_INCLUDED_PREFIXES) {
        const absoluteRoot = path.join(repoRoot, ...prefix.split('/').filter(Boolean));
        for (const filePath of listFilesUnder(absoluteRoot, traversal)) {
            const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
            if (isSensitiveEvidencePath(relativePath) || isGeneratedReviewSupportPath(relativePath)) {
                continue;
            }
            entries.add(relativePath);
            assertReleaseArchiveBudget(entries.size, 0);
        }
    }
    return [...entries].sort();
}

export function assertReleaseArchiveBudget(entryCount: number, totalBytes: number): void {
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(`Archive entry budget exceeded: ${entryCount} > ${MAX_ARCHIVE_ENTRIES}.`);
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_ARCHIVE_INPUT_BYTES) {
        throw new Error(`Archive input-byte budget exceeded: ${totalBytes} > ${MAX_ARCHIVE_INPUT_BYTES}.`);
    }
}

function buildEntries(repoRoot: string, relativePaths: readonly string[], kind: ReleaseArchiveKind): ReleaseArchiveEntry[] {
    assertReleaseArchiveBudget(relativePaths.length, 0);
    let totalBytes = 0;
    return relativePaths.map((relativePath, index) => {
        assertSafeRelativePath(relativePath);
        const absolutePath = path.join(repoRoot, ...relativePath.split('/'));
        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) {
            throw new Error(`Archive entry must be a file or symlink: ${relativePath}`);
        }
        const identity = sourceIdentity(stat);
        const linkTarget = stat.isSymbolicLink() ? fs.readlinkSync(absolutePath) : undefined;
        if (linkTarget !== undefined) {
            assertSupportedTarLinkTarget(linkTarget, relativePath);
            if (kind === 'evidence' && hasCredentialLikeContent(linkTarget)) {
                throw new Error(`Refusing to archive evidence symlink with credential-like target: ${relativePath}`);
            }
        }
        const size = linkTarget === undefined ? stat.size : Buffer.byteLength(linkTarget, 'utf8');
        totalBytes += size;
        assertReleaseArchiveBudget(index + 1, totalBytes);
        const sha256 = linkTarget === undefined
            ? hashAndScanFile(absolutePath, relativePath, identity, kind === 'evidence')
            : crypto.createHash('sha256').update(`symlink:${linkTarget}`).digest('hex');
        assertSourceIdentity(identity, fs.lstatSync(absolutePath), relativePath);
        return Object.freeze({
            relativePath,
            size,
            sha256,
            type: linkTarget === undefined ? 'file' : 'symlink',
            identity: Object.freeze(identity),
            ...(linkTarget === undefined ? {} : { linkTarget })
        });
    });
}

function resolveDefaultOutputPath(repoRoot: string, kind: ReleaseArchiveKind): string {
    return path.join(repoRoot, DEFAULT_OUTPUT_DIR, `garda-agent-orchestrator-${kind}.tar`);
}

function assertOutputSeparateFromInputs(repoRoot: string, outputPath: string, entries: readonly ReleaseArchiveEntry[]): void {
    const resolvedOutputPath = path.resolve(outputPath);
    const comparableOutputPath = process.platform === 'win32' ? resolvedOutputPath.toLowerCase() : resolvedOutputPath;
    let outputStat: fs.Stats | undefined;
    try {
        outputStat = fs.lstatSync(resolvedOutputPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    if (entries.some((entry) => {
        const selectedPath = path.resolve(repoRoot, ...entry.relativePath.split('/'));
        const sameSpelling = (process.platform === 'win32' ? selectedPath.toLowerCase() : selectedPath) === comparableOutputPath;
        const sameExistingFile = outputStat !== undefined && outputStat.ino !== 0
            && outputStat.dev === entry.identity.dev && outputStat.ino === entry.identity.ino;
        return sameSpelling || sameExistingFile;
    })) {
        throw new Error(`Archive output overlaps selected input: ${resolvedOutputPath}`);
    }
}

export function buildReleaseArchivePlan(kind: ReleaseArchiveKind, repoRoot = getRepoRoot(), outputPath?: string): ReleaseArchivePlan {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const resolvedOutputPath = path.resolve(outputPath || resolveDefaultOutputPath(normalizedRepoRoot, kind));
    const relativePaths = kind === 'source'
        ? listTrackedSourceFiles(normalizedRepoRoot)
        : listEvidenceFiles(normalizedRepoRoot);
    const entries = Object.freeze(buildEntries(normalizedRepoRoot, relativePaths, kind));
    assertOutputSeparateFromInputs(normalizedRepoRoot, resolvedOutputPath, entries);

    return Object.freeze({
        kind,
        repoRoot: normalizedRepoRoot,
        outputPath: resolvedOutputPath,
        entries
    });
}

function formatTarNumber(value: number, length: number): Buffer {
    const octal = value.toString(8);
    const text = `${octal.padStart(length - 1, '0')}\0`;
    return Buffer.from(text, 'ascii');
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
    const payload = Buffer.from(value, 'utf8');
    payload.copy(header, offset, 0, Math.min(payload.length, length));
}

export function assertSupportedTarLinkTarget(linkTarget: string, relativePath: string): void {
    const resolvedTarget = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), linkTarget));
    if (!linkTarget || linkTarget.includes('\0') || linkTarget.includes('\\')
        || path.posix.isAbsolute(linkTarget) || path.win32.isAbsolute(linkTarget)
        || /(^|\/)[A-Za-z]:/u.test(linkTarget)
        || resolvedTarget === '..' || resolvedTarget.startsWith('../')
        || Buffer.byteLength(linkTarget, 'utf8') > TAR_LINK_NAME_BYTES) {
        throw new Error(`Unsupported archive symlink target: ${relativePath}`);
    }
}

function splitTarPath(relativePath: string): { name: string; prefix: string } {
    const pathBytes = Buffer.byteLength(relativePath, 'utf8');
    if (pathBytes <= 100) {
        return { name: relativePath, prefix: '' };
    }
    for (let index = relativePath.lastIndexOf('/'); index > 0; index = relativePath.lastIndexOf('/', index - 1)) {
        const prefix = relativePath.slice(0, index);
        const name = relativePath.slice(index + 1);
        if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
            return { name, prefix };
        }
    }
    return { name: relativePath.slice(-100), prefix: '' };
}

function buildTarHeader(relativePath: string, size: number, typeFlag: string, linkName = ''): Buffer {
    if (typeFlag === '2') {
        assertSupportedTarLinkTarget(linkName, relativePath);
    }
    const header = Buffer.alloc(512, 0);
    const { name, prefix } = splitTarPath(relativePath);
    writeTarString(header, 0, 100, name);
    formatTarNumber(typeFlag === '2' ? 0o777 : 0o644, 8).copy(header, 100);
    formatTarNumber(0, 8).copy(header, 108);
    formatTarNumber(0, 8).copy(header, 116);
    formatTarNumber(size, 12).copy(header, 124);
    formatTarNumber(0, 12).copy(header, 136);
    Buffer.from('        ', 'ascii').copy(header, 148);
    writeTarString(header, 156, 1, typeFlag);
    writeTarString(header, 157, 100, linkName);
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    writeTarString(header, 345, 155, prefix);

    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    const checksumText = checksum.toString(8).padStart(6, '0');
    Buffer.from(`${checksumText}\0 `, 'ascii').copy(header, 148);
    return header;
}

function padTarContent(content: Buffer): Buffer {
    const remainder = content.length % 512;
    if (remainder === 0) {
        return content;
    }
    return Buffer.concat([content, Buffer.alloc(512 - remainder, 0)]);
}

function buildPaxPathContent(relativePath: string): Buffer {
    let length = 0;
    let line = '';
    do {
        line = `${length} path=${relativePath}\n`;
        length = Buffer.byteLength(line, 'utf8');
        line = `${length} path=${relativePath}\n`;
    } while (Buffer.byteLength(line, 'utf8') !== length);
    return Buffer.from(line, 'utf8');
}

function maybeBuildPaxHeader(relativePath: string): Buffer[] {
    if (Buffer.byteLength(relativePath, 'utf8') <= 100 || splitTarPath(relativePath).prefix) {
        return [];
    }
    const paxContent = buildPaxPathContent(relativePath);
    const paxName = `PaxHeaders/${crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}.pax`;
    return [buildTarHeader(paxName, paxContent.length, 'x'), padTarContent(paxContent)];
}

function buildManifestContent(plan: ReleaseArchivePlan): Buffer {
    const payload = {
        schema_version: 1,
        archive_kind: plan.kind,
        deterministic: true,
        entry_count: plan.entries.length,
        entries: plan.entries.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 }))
    };
    return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildTarFileEntry(relativePath: string, content: Buffer, typeFlag = '0', linkName = ''): Buffer[] {
    return [
        ...maybeBuildPaxHeader(relativePath),
        buildTarHeader(relativePath, content.length, typeFlag, linkName),
        padTarContent(content)
    ];
}

function writeArchiveBuffer(descriptor: number, content: Buffer): void {
    let offset = 0;
    while (offset < content.length) {
        const written = fs.writeSync(descriptor, content, offset, content.length - offset);
        if (written === 0) {
            throw new Error('Archive output write made no progress.');
        }
        offset += written;
    }
}

function writeTarEntryHeader(descriptor: number, relativePath: string, size: number, typeFlag: string, linkName = ''): void {
    for (const part of maybeBuildPaxHeader(relativePath)) {
        writeArchiveBuffer(descriptor, part);
    }
    writeArchiveBuffer(descriptor, buildTarHeader(relativePath, size, typeFlag, linkName));
}

function writePlannedEntry(outputDescriptor: number, plan: ReleaseArchivePlan, entry: ReleaseArchiveEntry): void {
    assertSafeRelativePath(entry.relativePath);
    const absolutePath = path.join(plan.repoRoot, ...entry.relativePath.split('/'));
    const stat = fs.lstatSync(absolutePath);
    assertSourceIdentity(entry.identity, stat, entry.relativePath);
    if (entry.type === 'symlink') {
        if (!stat.isSymbolicLink()) {
            throw new Error(`Archive input type changed: ${entry.relativePath}`);
        }
        const linkName = fs.readlinkSync(absolutePath);
        assertSupportedTarLinkTarget(linkName, entry.relativePath);
        if (linkName !== entry.linkTarget || Buffer.byteLength(linkName, 'utf8') !== entry.size
            || crypto.createHash('sha256').update(`symlink:${linkName}`).digest('hex') !== entry.sha256) {
            throw new Error(`Archive input digest changed: ${entry.relativePath}`);
        }
        assertSourceIdentity(entry.identity, fs.lstatSync(absolutePath), entry.relativePath);
        writeTarEntryHeader(outputDescriptor, entry.relativePath, 0, '2', linkName);
        return;
    }
    if (!stat.isFile()) {
        throw new Error(`Archive input type changed: ${entry.relativePath}`);
    }
    const inputDescriptor = fs.openSync(absolutePath, 'r');
    try {
        assertSourceIdentity(entry.identity, fs.fstatSync(inputDescriptor), entry.relativePath);
        writeTarEntryHeader(outputDescriptor, entry.relativePath, entry.size, '0');
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(Math.min(EVIDENCE_SECRET_SCAN_CHUNK_BYTES, Math.max(entry.size, 1)));
        let position = 0;
        while (position < entry.size) {
            const bytesRead = fs.readSync(inputDescriptor, buffer, 0, Math.min(buffer.length, entry.size - position), position);
            if (bytesRead === 0) {
                throw new Error(`Archive input changed while reading: ${entry.relativePath}`);
            }
            hash.update(buffer.subarray(0, bytesRead));
            writeArchiveBuffer(outputDescriptor, buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        assertSourceIdentity(entry.identity, fs.fstatSync(inputDescriptor), entry.relativePath);
        assertSourceIdentity(entry.identity, fs.lstatSync(absolutePath), entry.relativePath);
        if (hash.digest('hex') !== entry.sha256) {
            throw new Error(`Archive input digest changed: ${entry.relativePath}`);
        }
    } finally {
        fs.closeSync(inputDescriptor);
    }
    const remainder = entry.size % 512;
    if (remainder !== 0) {
        writeArchiveBuffer(outputDescriptor, Buffer.alloc(512 - remainder, 0));
    }
}

export function writeReleaseArchivePlan(plan: ReleaseArchivePlan): void {
    assertOutputSeparateFromInputs(plan.repoRoot, plan.outputPath, plan.entries);
    assertReleaseArchiveBudget(plan.entries.length, plan.entries.reduce((sum, entry) => sum + entry.size, 0));
    writeArchiveOutput(plan.outputPath, (descriptor) => {
        for (const part of buildTarFileEntry(MANIFEST_ENTRY_PATH, buildManifestContent(plan))) {
            writeArchiveBuffer(descriptor, part);
        }
        for (const entry of plan.entries) {
            writePlannedEntry(descriptor, plan, entry);
        }
        writeArchiveBuffer(descriptor, Buffer.alloc(1024, 0));
    });
}

function assertSafeArchiveOutput(outputPath: string): void {
    const resolvedPath = path.resolve(outputPath);
    const root = path.parse(resolvedPath).root;
    let directory = root;
    for (const segment of path.dirname(resolvedPath).slice(root.length).split(path.sep).filter(Boolean)) {
        directory = path.join(directory, segment);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Unsafe archive output directory: ${directory}`);
        }
    }
    try {
        const stat = fs.lstatSync(resolvedPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Unsafe archive output path: ${resolvedPath}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

function writeArchiveOutput(outputPath: string, write: (descriptor: number) => void): void {
    assertSafeArchiveOutput(outputPath);
    const outputDirectory = path.dirname(outputPath);
    fs.mkdirSync(outputDirectory, { recursive: true });
    assertSafeArchiveOutput(outputPath);
    const temporaryPath = path.join(outputDirectory, `.archive-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let created = false;
    try {
        const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        created = true;
        try {
            write(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        assertSafeArchiveOutput(outputPath);
        fs.renameSync(temporaryPath, outputPath);
    } finally {
        if (created) {
            fs.rmSync(temporaryPath, { force: true });
        }
    }
}

export function createReleaseArchive(kind: ReleaseArchiveKind, repoRoot = getRepoRoot(), outputPath?: string): ReleaseArchivePlan {
    const plan = buildReleaseArchivePlan(kind, repoRoot, outputPath);
    writeReleaseArchivePlan(plan);
    return plan;
}

function parseCliArgs(argv: readonly string[]): { kind: ReleaseArchiveKind | null; outputPath?: string } {
    const kind = argv[0] === 'source' || argv[0] === 'evidence' ? argv[0] : null;
    let outputPath: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
        if (argv[index] === '--output') {
            outputPath = argv[index + 1];
            index += 1;
            continue;
        }
        throw new Error(`Unknown archive-release argument: ${argv[index]}`);
    }
    return { kind, outputPath };
}

export function runReleaseArchiveCli(argv = process.argv.slice(2)): void {
    const { kind, outputPath } = parseCliArgs(argv);
    if (kind === null) {
        console.error('Usage: archive-release.js <source|evidence> [--output <path>]');
        process.exit(1);
    }
    const plan = createReleaseArchive(kind, getRepoRoot(), outputPath);
    console.log('RELEASE_ARCHIVE_CREATED');
    console.log(`ArchiveKind: ${plan.kind}`);
    console.log(`ArchivePath: ${plan.outputPath}`);
    console.log(`EntryCount: ${plan.entries.length}`);
}

if (require.main === module) {
    runReleaseArchiveCli();
}
