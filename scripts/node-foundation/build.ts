import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_CLI_SYNC_LOCK_TIMEOUT_MS = 30000;
const REPO_CLI_SYNC_LOCK_STALE_MS = 60000;
const REPO_CLI_SYNC_BACKOFF_BASE_MS = 50;
const REPO_CLI_SYNC_BACKOFF_MULTIPLIER = 2;
const REPO_CLI_SYNC_BACKOFF_MAX_MS = 2000;
const REPO_CLI_SYNC_MAX_RETRIES = 8;
const PRIMARY_COMPILED_CLI_RELATIVE_PATH = path.join('src', 'bin', 'garda.js');
const PRIMARY_REPO_CLI_RELATIVE_PATH = path.join('bin', 'garda.js');
const PRIMARY_COMPILED_CLI_COMPANION_DIRECTORY = path.join('src', 'bin', 'garda');
const PRIMARY_REPO_CLI_COMPANION_DIRECTORY = path.join('bin', 'garda');
const REPO_CLI_LAUNCHER_MODE = 0o755;
const REPO_CLI_COMPANION_MODE = 0o644;
const REPO_CLI_SYNC_LOCK_NAME = '.garda-cli-sync.lock';
const BUILD_FINGERPRINT_SCHEMA_VERSION = 1 as const;
const NODE_FOUNDATION_FORCE_REBUILD_ENV = 'GARDA_NODE_FOUNDATION_FORCE_REBUILD';
const PUBLISH_RUNTIME_FORCE_REBUILD_ENV = 'GARDA_PUBLISH_RUNTIME_FORCE_REBUILD';
const BUILD_TSC_TIMEOUT_MS = 10 * 60 * 1000;
const {
    resetBuildRoot,
    withBuildRootLock
} = require('./build-root-lock.cjs') as {
    resetBuildRoot: (buildRoot: string) => void;
    withBuildRootLock: <T>(buildRoot: string, operation: () => T) => T;
};

export { withBuildRootLock };

export interface BuildResult {
    buildRoot: string;
    copiedFiles: string[];
    generatedCliPath: string;
    manifestPath: string;
    repoRoot: string;
}

export interface BuildInputFingerprint {
    schemaVersion: 1;
    kind: 'node-foundation' | 'publish-runtime';
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    nodeEngineRange: string;
    typescriptVersion: string;
    fileCount: number;
    files: Array<{
        path: string;
        size: number;
        sha256: string;
    }>;
    sha256: string;
}

interface BuildManifest {
    nodeEngineRange?: string;
    sourceRoots?: string[];
    files?: string[];
    inputFingerprint?: BuildInputFingerprint;
    publishedManifestSha256?: string;
}

export interface ReusableBuildCheck {
    accepted: boolean;
    reason: string;
    manifest?: BuildManifest;
}

export interface RepoCliSyncFsLike {
    chmodSync: typeof fs.chmodSync;
    existsSync: typeof fs.existsSync;
    mkdirSync: typeof fs.mkdirSync;
    readFileSync: typeof fs.readFileSync;
    readdirSync: typeof fs.readdirSync;
    renameSync: typeof fs.renameSync;
    rmSync: typeof fs.rmSync;
    statSync: typeof fs.statSync;
    writeFileSync: typeof fs.writeFileSync;
}

const DEFAULT_REPO_CLI_SYNC_FS: RepoCliSyncFsLike = fs;
const SCRIPT_RUNTIME_SUPPORT_FILES = Object.freeze(['build-root-lock.cjs', 'build-scripts.cjs']);
const SOURCE_MAPPING_URL_COMMENT_RE = /(\r?\n)\/\/# sourceMappingURL=[^\r\n]+\.map\s*$/u;
const INPUT_FILE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.ts']);

export function getRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'VERSION'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root from ' + __dirname);
}

function getNodeEngineRange(repoRoot: string = getRepoRoot()): string {
    const pkg: { engines?: { node?: string } } =
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return (pkg.engines && pkg.engines.node) || '^22.13.0 || >=24.0.0';
}

function collectFiles(rootPath: string, extension: string = '.js'): string[] {
    if (!fs.existsSync(rootPath)) {
        return [];
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(entryPath, extension));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(extension)) {
            files.push(entryPath);
        }
    }

    return files.sort();
}

function collectFilesByExtensions(rootPath: string, extensions: readonly string[]): string[] {
    return extensions.flatMap((extension) => collectFiles(rootPath, extension)).sort();
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
    return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function hashText(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonFileIfExists<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function readTypescriptVersion(repoRoot: string): string {
    const pkg = readJsonFileIfExists<{ version?: unknown }>(path.join(repoRoot, 'node_modules', 'typescript', 'package.json'));
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
}

function shouldFingerprintFile(filePath: string): boolean {
    return INPUT_FILE_EXTENSIONS.has(path.extname(filePath));
}

function collectInputFiles(repoRoot: string, inputPaths: string[]): string[] {
    const files: string[] = [];
    const visit = (absolutePath: string): void => {
        if (!fs.existsSync(absolutePath)) {
            return;
        }
        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    continue;
                }
                visit(path.join(absolutePath, entry.name));
            }
            return;
        }
        if (stat.isFile() && shouldFingerprintFile(absolutePath)) {
            files.push(absolutePath);
        }
    };

    for (const inputPath of inputPaths) {
        visit(path.join(repoRoot, ...inputPath.split('/')));
    }
    return Array.from(new Set(files.map((filePath) => path.resolve(filePath)))).sort((a, b) =>
        toRepoRelativePath(repoRoot, a).localeCompare(toRepoRelativePath(repoRoot, b))
    );
}

function buildInputFingerprint(
    repoRoot: string,
    kind: BuildInputFingerprint['kind'],
    inputPaths: string[]
): BuildInputFingerprint {
    const files = collectInputFiles(repoRoot, inputPaths).map((filePath) => {
        const stat = fs.statSync(filePath);
        return {
            path: toRepoRelativePath(repoRoot, filePath),
            size: stat.size,
            sha256: hashFile(filePath)
        };
    });
    const payload = {
        schemaVersion: BUILD_FINGERPRINT_SCHEMA_VERSION,
        kind,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        nodeEngineRange: getNodeEngineRange(repoRoot),
        typescriptVersion: readTypescriptVersion(repoRoot),
        fileCount: files.length,
        files
    };
    return {
        ...payload,
        sha256: hashText(JSON.stringify(payload))
    };
}

export function buildNodeFoundationInputFingerprint(repoRoot: string = getRepoRoot()): BuildInputFingerprint {
    return buildInputFingerprint(repoRoot, 'node-foundation', [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tsconfig.tests.json',
        'src',
        'tests/node',
        'scripts/node-foundation'
    ]);
}

export function buildPublishRuntimeInputFingerprint(repoRoot: string = getRepoRoot()): BuildInputFingerprint {
    return buildInputFingerprint(repoRoot, 'publish-runtime', [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tsconfig.build.json',
        'VERSION',
        'src',
        'scripts/node-foundation'
    ]);
}

function readBuildManifest(manifestPath: string): BuildManifest | null {
    return readJsonFileIfExists<BuildManifest>(manifestPath);
}

function manifestFilesExist(buildRoot: string, manifest: BuildManifest): boolean {
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
        return false;
    }
    return manifest.files.every((relativePath) =>
        typeof relativePath === 'string'
            && fs.existsSync(path.join(buildRoot, ...relativePath.split('/')))
            && fs.statSync(path.join(buildRoot, ...relativePath.split('/'))).isFile()
    );
}

function getExpectedBuildSourceRoots(requiresScriptSupport: boolean): string[] {
    return requiresScriptSupport ? ['src', 'tests/node', 'scripts/node-foundation'] : ['src'];
}

function manifestCoversDiscoveredBuildFiles(
    buildRoot: string,
    manifest: BuildManifest,
    requiresScriptSupport: boolean
): boolean {
    if (!Array.isArray(manifest.files)) {
        return false;
    }
    const manifestFiles = new Set(manifest.files.filter((filePath): filePath is string => typeof filePath === 'string'));
    const discoveredFiles: string[] = [];
    for (const sourceRoot of getExpectedBuildSourceRoots(requiresScriptSupport)) {
        const absoluteRoot = path.join(buildRoot, ...sourceRoot.split('/'));
        if (!fs.existsSync(absoluteRoot)) {
            continue;
        }
        for (const absolutePath of collectFilesByExtensions(absoluteRoot, ['.js', '.json'])) {
            discoveredFiles.push(path.relative(buildRoot, absolutePath).split(path.sep).join('/'));
        }
    }
    if (discoveredFiles.length === 0) {
        return false;
    }
    return discoveredFiles.every((relativePath) => manifestFiles.has(relativePath));
}

function supportFilesExist(buildRoot: string): boolean {
    return SCRIPT_RUNTIME_SUPPORT_FILES.every((fileName) => {
        const supportPath = path.join(buildRoot, 'scripts', 'node-foundation', fileName);
        return fs.existsSync(supportPath) && fs.statSync(supportPath).isFile();
    });
}

export function checkReusableBuildRoot(
    buildRoot: string,
    manifestPath: string,
    expectedFingerprint: BuildInputFingerprint,
    forceRebuildEnvName: string,
    requiresScriptSupport: boolean,
    publishedManifestPath?: string
): ReusableBuildCheck {
    if (process.env[forceRebuildEnvName] === '1') {
        return { accepted: false, reason: `${forceRebuildEnvName}=1` };
    }
    const manifest = readBuildManifest(manifestPath);
    if (!manifest) {
        return { accepted: false, reason: 'manifest_missing_or_unreadable' };
    }
    if (manifest.inputFingerprint?.sha256 !== expectedFingerprint.sha256) {
        return { accepted: false, reason: 'input_fingerprint_mismatch', manifest };
    }
    if (publishedManifestPath) {
        const publishedManifest = readFileIfExists(publishedManifestPath, DEFAULT_REPO_CLI_SYNC_FS);
        const publishedManifestSha256 = publishedManifest
            ? crypto.createHash('sha256').update(publishedManifest).digest('hex')
            : undefined;
        if (!publishedManifestSha256 || manifest.publishedManifestSha256 !== publishedManifestSha256) {
            return { accepted: false, reason: 'published_manifest_mismatch', manifest };
        }
    }
    if (!manifestFilesExist(buildRoot, manifest)) {
        return { accepted: false, reason: 'compiled_files_missing', manifest };
    }
    if (!manifestCoversDiscoveredBuildFiles(buildRoot, manifest, requiresScriptSupport)) {
        return { accepted: false, reason: 'manifest_incomplete', manifest };
    }
    if (requiresScriptSupport && !supportFilesExist(buildRoot)) {
        return { accepted: false, reason: 'script_support_missing', manifest };
    }
    const compiledCliPath = path.join(buildRoot, PRIMARY_COMPILED_CLI_RELATIVE_PATH);
    if (!fs.existsSync(compiledCliPath) || !fs.statSync(compiledCliPath).isFile()) {
        return { accepted: false, reason: 'compiled_cli_missing', manifest };
    }
    return { accepted: true, reason: 'input_fingerprint_match', manifest };
}

export function printReuseDiagnostic(label: string, check: ReusableBuildCheck, fingerprint: BuildInputFingerprint): void {
    const status = check.accepted ? 'accepted' : 'rejected';
    console.log(`${label}_REUSE ${status} reason=${check.reason} fingerprint=${fingerprint.sha256.slice(0, 16)}`);
}

function copiedFilesFromManifest(manifest: BuildManifest | undefined): string[] {
    return Array.isArray(manifest?.files)
        ? manifest.files.filter((filePath): filePath is string => typeof filePath === 'string').slice()
        : [];
}

interface BoundedSpawnSyncResult {
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    timedOut?: boolean;
}

type TscProcessRunner = (
    command: string,
    args: string[],
    options: {
        cwd: string;
        stdio: 'inherit';
        timeoutMs: number;
        windowsHide: true;
        env: NodeJS.ProcessEnv;
    }
) => BoundedSpawnSyncResult;

function formatTscCommand(tscCliPath: string, args: string[]): string {
    return [process.execPath, tscCliPath, ...args].join(' ');
}

function runBoundedSpawnSync(
    command: string,
    args: string[],
    options: {
        cwd: string;
        stdio: 'inherit';
        timeoutMs: number;
        windowsHide: true;
        env: NodeJS.ProcessEnv;
    }
): BoundedSpawnSyncResult {
    const result = childProcess.spawnSync(command, args, {
        cwd: options.cwd,
        stdio: options.stdio,
        timeout: options.timeoutMs,
        windowsHide: options.windowsHide,
        env: options.env
    }) as BoundedSpawnSyncResult;
    const errorCode = result.error && typeof result.error === 'object' && 'code' in result.error
        ? String((result.error as NodeJS.ErrnoException).code || '')
        : '';
    result.timedOut = errorCode === 'ETIMEDOUT' || (result.signal === 'SIGTERM' && options.timeoutMs > 0);
    return result;
}

export function runTsc(
    args: string[],
    repoRoot: string,
    options?: { processRunner?: TscProcessRunner; timeoutMs?: number }
): void {
    const tscCliPath = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tscCliPath)) {
        throw new Error(`TypeScript CLI not found: ${tscCliPath}`);
    }

    const timeoutMs = options?.timeoutMs ?? BUILD_TSC_TIMEOUT_MS;
    const processRunner = options?.processRunner ?? runBoundedSpawnSync;
    const result = processRunner(process.execPath, [tscCliPath, ...args], {
        cwd: repoRoot,
        stdio: 'inherit',
        timeoutMs,
        env: {
            ...process.env,
            NODE_OPTIONS: ''
        },
        windowsHide: true
    });
    if (result.timedOut) {
        throw new Error(
            `TypeScript compilation timed out after ${timeoutMs} ms: ${formatTscCommand(tscCliPath, args)}`
        );
    }
    if (result.error) {
        throw new Error(`TypeScript compilation failed to start: ${result.error.message}`);
    }
    if (result.signal) {
        throw new Error(`TypeScript compilation terminated by signal ${result.signal}: ${formatTscCommand(tscCliPath, args)}`);
    }
    if (result.status !== 0) {
        throw new Error('TypeScript compilation failed (exit ' + result.status + ')');
    }
}

function copyUiLanguagePacksFromSource(repoRoot: string, buildRoot: string): void {
    const sourceDirectory = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');
    const destinationDirectory = path.join(buildRoot, 'src', 'reports', 'ui', 'lang-packs');
    if (!fs.existsSync(sourceDirectory)) {
        throw new Error(`Missing UI language packs source directory: ${sourceDirectory}`);
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });
    for (const fileName of fs.readdirSync(sourceDirectory)) {
        if (!/^garda-ui-.+\.json$/u.test(fileName)) {
            continue;
        }
        fs.copyFileSync(path.join(sourceDirectory, fileName), path.join(destinationDirectory, fileName));
    }
}

function copyScriptRuntimeSupportFiles(compiledRoot: string, repoRoot: string): void {
    const compiledScriptsRoot = path.join(compiledRoot, 'scripts', 'node-foundation');
    fs.mkdirSync(compiledScriptsRoot, { recursive: true });

    for (const fileName of SCRIPT_RUNTIME_SUPPORT_FILES) {
        const sourcePath = path.join(repoRoot, 'scripts', 'node-foundation', fileName);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Script runtime support file not found: ${sourcePath}`);
        }
        fs.copyFileSync(sourcePath, path.join(compiledScriptsRoot, fileName));
    }
}

function getErrorCode(error: unknown): string {
    return error != null && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
}

function isRetryableCliSyncError(error: unknown): boolean {
    const errorCode = getErrorCode(error);
    return errorCode === 'EBUSY' || errorCode === 'EPERM' || errorCode === 'EACCES' || errorCode === 'EEXIST';
}

function sleepSync(milliseconds: number): void {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function safeUnlink(filePath: string, fileSystem: RepoCliSyncFsLike): void {
    try {
        fileSystem.rmSync(filePath, { force: true });
    } catch {
        // best-effort temp cleanup
    }
}

function makeTempCliPath(repoCliPath: string): string {
    return `${repoCliPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function readFileIfExists(filePath: string, fileSystem: RepoCliSyncFsLike): Buffer | null {
    try {
        return fileSystem.readFileSync(filePath);
    } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function fileContentMatches(filePath: string, expectedContent: Buffer, fileSystem: RepoCliSyncFsLike): boolean {
    const currentContent = readFileIfExists(filePath, fileSystem);
    return currentContent !== null && Buffer.compare(currentContent, expectedContent) === 0;
}

function fileContentMatchesOrContended(filePath: string, expectedContent: Buffer, fileSystem: RepoCliSyncFsLike): boolean {
    try {
        return fileContentMatches(filePath, expectedContent, fileSystem);
    } catch (error: unknown) {
        if (isRetryableCliSyncError(error)) {
            return false;
        }
        throw error;
    }
}

function collectCliCompanionFiles(rootPath: string, fileSystem: RepoCliSyncFsLike): string[] {
    if (!fileSystem.existsSync(rootPath)) {
        return [];
    }

    const files: string[] = [];
    const visit = (currentPath: string, relativePrefix: string): void => {
        const entries = fileSystem.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(currentPath, entry.name);
            const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
            if (entry.isDirectory()) {
                visit(absolutePath, relativePath);
                continue;
            }
            if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.json'))) {
                files.push(relativePath.split(path.sep).join('/'));
            }
        }
    };

    visit(rootPath, '');
    return files.sort();
}

function cliCompanionDirectoryMatches(
    compiledCompanionDirectory: string,
    repoCompanionDirectory: string,
    fileSystem: RepoCliSyncFsLike
): boolean {
    const compiledFiles = collectCliCompanionFiles(compiledCompanionDirectory, fileSystem);
    const repoFiles = collectCliCompanionFiles(repoCompanionDirectory, fileSystem);
    if (compiledFiles.length !== repoFiles.length) {
        return false;
    }
    for (let index = 0; index < compiledFiles.length; index += 1) {
        const relativePath = compiledFiles[index];
        if (repoFiles[index] !== relativePath) {
            return false;
        }
        const compiledPath = path.join(compiledCompanionDirectory, ...relativePath.split('/'));
        const repoPath = path.join(repoCompanionDirectory, ...relativePath.split('/'));
        const compiledContent = readFileIfExists(compiledPath, fileSystem);
        if (
            compiledContent === null
            || !fileContentMatchesOrContended(repoPath, normalizeRepoCliEntrypointContent(compiledContent), fileSystem)
        ) {
            return false;
        }
    }
    return true;
}

function normalizeRepoCliEntrypointContent(content: Buffer): Buffer {
    const text = content.toString('utf8');
    const normalized = text.replace(SOURCE_MAPPING_URL_COMMENT_RE, '$1');
    return normalized === text ? content : Buffer.from(normalized, 'utf8');
}

function ensureRepoCliFileMode(filePath: string, mode: number, fileSystem: RepoCliSyncFsLike): void {
    if (process.platform === 'win32') {
        return;
    }
    try {
        fileSystem.chmodSync(filePath, mode);
    } catch {
        // Best-effort on filesystems that do not support POSIX modes.
    }
}

function computeBackoffDelay(attempt: number): number {
    const delay = REPO_CLI_SYNC_BACKOFF_BASE_MS * Math.pow(REPO_CLI_SYNC_BACKOFF_MULTIPLIER, attempt);
    const jitter = Math.random() * REPO_CLI_SYNC_BACKOFF_BASE_MS;
    return Math.min(delay + jitter, REPO_CLI_SYNC_BACKOFF_MAX_MS);
}

function isLockStale(lockPath: string): boolean {
    try {
        const stat = fs.statSync(lockPath);
        return (Date.now() - stat.mtimeMs) >= REPO_CLI_SYNC_LOCK_STALE_MS;
    } catch {
        return false;
    }
}

function forceRemoveStaleLock(lockPath: string, fileSystem: RepoCliSyncFsLike): boolean {
    try {
        fileSystem.rmSync(lockPath, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

function acquireRepoCliSyncLock(lockPath: string, fileSystem: RepoCliSyncFsLike): void {
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
        try {
            fileSystem.mkdirSync(lockPath);
            return;
        } catch (error: unknown) {
            const errorCode = getErrorCode(error);
            if (errorCode === 'EEXIST') {
                if (isLockStale(lockPath) && forceRemoveStaleLock(lockPath, fileSystem)) {
                    continue;
                }
            } else if (errorCode === 'EPERM' || errorCode === 'EACCES' || errorCode === 'EBUSY') {
                // Retryable Windows contention errors — fall through to backoff
            } else {
                throw error;
            }
            if (Date.now() - startedAt >= REPO_CLI_SYNC_LOCK_TIMEOUT_MS) {
                if (isLockStale(lockPath) && forceRemoveStaleLock(lockPath, fileSystem)) {
                    continue;
                }
                throw new Error(`Timed out acquiring repo CLI sync lock: ${lockPath}`);
            }
            sleepSync(computeBackoffDelay(attempt));
            attempt += 1;
        }
    }
}

function releaseRepoCliSyncLock(lockPath: string, fileSystem: RepoCliSyncFsLike): void {
    for (let attempt = 0; attempt <= 3; attempt += 1) {
        try {
            fileSystem.rmSync(lockPath, { recursive: true, force: true });
            return;
        } catch (error: unknown) {
            const errorCode = getErrorCode(error);
            if ((errorCode === 'EPERM' || errorCode === 'EBUSY' || errorCode === 'EACCES') && attempt < 3) {
                sleepSync(computeBackoffDelay(attempt));
                continue;
            }
            // best-effort lock cleanup — swallow remaining errors
            return;
        }
    }
}

function replaceRepoCliFile(repoCliPath: string, desiredContent: Buffer, mode: number, fileSystem: RepoCliSyncFsLike): void {
    for (let attempt = 0; attempt <= REPO_CLI_SYNC_MAX_RETRIES; attempt += 1) {
        const tempCliPath = makeTempCliPath(repoCliPath);
        try {
            if (fileContentMatchesOrContended(repoCliPath, desiredContent, fileSystem)) {
                ensureRepoCliFileMode(repoCliPath, mode, fileSystem);
                return;
            }

            fileSystem.writeFileSync(tempCliPath, desiredContent);
            ensureRepoCliFileMode(tempCliPath, mode, fileSystem);

            safeUnlink(repoCliPath, fileSystem);
            fileSystem.renameSync(tempCliPath, repoCliPath);
            ensureRepoCliFileMode(repoCliPath, mode, fileSystem);
            return;
        } catch (error: unknown) {
            safeUnlink(tempCliPath, fileSystem);

            if (fileContentMatchesOrContended(repoCliPath, desiredContent, fileSystem)) {
                ensureRepoCliFileMode(repoCliPath, mode, fileSystem);
                return;
            }
            if (!isRetryableCliSyncError(error) || attempt >= REPO_CLI_SYNC_MAX_RETRIES) {
                throw error;
            }
            sleepSync(computeBackoffDelay(attempt));
        }
    }
}

function replaceRepoCliCompanionDirectory(
    compiledCompanionDirectory: string,
    repoCompanionDirectory: string,
    fileSystem: RepoCliSyncFsLike
): void {
    const companionFiles = collectCliCompanionFiles(compiledCompanionDirectory, fileSystem);
    const expectedCompanionFiles = new Set(companionFiles);
    for (const relativePath of companionFiles) {
        const sourcePath = path.join(compiledCompanionDirectory, ...relativePath.split('/'));
        const destinationPath = path.join(repoCompanionDirectory, ...relativePath.split('/'));
        const sourceContent = normalizeRepoCliEntrypointContent(fileSystem.readFileSync(sourcePath));
        fileSystem.mkdirSync(path.dirname(destinationPath), { recursive: true });
        replaceRepoCliFile(destinationPath, sourceContent, REPO_CLI_COMPANION_MODE, fileSystem);
    }

    for (const relativePath of collectCliCompanionFiles(repoCompanionDirectory, fileSystem)) {
        if (expectedCompanionFiles.has(relativePath)) {
            continue;
        }
        fileSystem.rmSync(path.join(repoCompanionDirectory, ...relativePath.split('/')), { force: true });
    }
}

export function syncRepoCliEntrypoint(compiledRoot: string, repoRoot: string, fileSystem: RepoCliSyncFsLike = DEFAULT_REPO_CLI_SYNC_FS): string {
    const primaryCompiledPath = path.join(compiledRoot, PRIMARY_COMPILED_CLI_RELATIVE_PATH);
    if (!fileSystem.existsSync(primaryCompiledPath)) {
        throw new Error(`Compiled CLI launcher not found: ${primaryCompiledPath}`);
    }

    const repoCliPath = path.join(repoRoot, PRIMARY_REPO_CLI_RELATIVE_PATH);
    const compiledCompanionDirectory = path.join(compiledRoot, PRIMARY_COMPILED_CLI_COMPANION_DIRECTORY);
    const repoCompanionDirectory = path.join(repoRoot, PRIMARY_REPO_CLI_COMPANION_DIRECTORY);

    // Fast no-op path: skip lock acquisition when entrypoint is already up-to-date
    const compiledCliContentForCheck = readFileIfExists(primaryCompiledPath, fileSystem);
    const desiredCliContentForCheck = compiledCliContentForCheck === null
        ? null
        : normalizeRepoCliEntrypointContent(compiledCliContentForCheck);
    if (
        desiredCliContentForCheck !== null
        && fileContentMatchesOrContended(repoCliPath, desiredCliContentForCheck, fileSystem)
        && cliCompanionDirectoryMatches(compiledCompanionDirectory, repoCompanionDirectory, fileSystem)
    ) {
        ensureRepoCliFileMode(repoCliPath, REPO_CLI_LAUNCHER_MODE, fileSystem);
        if (process.platform !== 'win32') {
            for (const relativePath of collectCliCompanionFiles(repoCompanionDirectory, fileSystem)) {
                ensureRepoCliFileMode(
                    path.join(repoCompanionDirectory, ...relativePath.split('/')),
                    REPO_CLI_COMPANION_MODE,
                    fileSystem
                );
            }
        }
        return repoCliPath;
    }

    const repoCliLockPath = path.join(path.dirname(repoCliPath), REPO_CLI_SYNC_LOCK_NAME);
    fileSystem.mkdirSync(path.dirname(repoCliPath), { recursive: true });
    acquireRepoCliSyncLock(repoCliLockPath, fileSystem);
    try {
        const compiledCliContent = normalizeRepoCliEntrypointContent(fileSystem.readFileSync(primaryCompiledPath));
        replaceRepoCliCompanionDirectory(compiledCompanionDirectory, repoCompanionDirectory, fileSystem);
        replaceRepoCliFile(repoCliPath, compiledCliContent, REPO_CLI_LAUNCHER_MODE, fileSystem);
    } finally {
        releaseRepoCliSyncLock(repoCliLockPath, fileSystem);
    }

    return repoCliPath;
}

export function syncRepoCliFromScriptsBuild(): string {
    const repoRoot = getRepoRoot();
    return syncRepoCliEntrypoint(path.join(repoRoot, '.scripts-build'), repoRoot);
}

export function buildNodeFoundation(): BuildResult {
    const repoRoot = getRepoRoot();
    const buildRoot = path.join(repoRoot, '.node-build');
    return withBuildRootLock(buildRoot, () => {
        const inputFingerprint = buildNodeFoundationInputFingerprint(repoRoot);
        const manifestPath = path.join(buildRoot, 'node-foundation-manifest.json');
        const reusable = checkReusableBuildRoot(
            buildRoot,
            manifestPath,
            inputFingerprint,
            NODE_FOUNDATION_FORCE_REBUILD_ENV,
            true
        );
        printReuseDiagnostic('NODE_FOUNDATION_BUILD', reusable, inputFingerprint);
        if (reusable.accepted) {
            const generatedCliPath = syncRepoCliEntrypoint(buildRoot, repoRoot);
            return {
                buildRoot,
                copiedFiles: copiedFilesFromManifest(reusable.manifest),
                generatedCliPath,
                manifestPath,
                repoRoot
            };
        }

        resetBuildRoot(buildRoot);

        // Compile the maintained runtime/test/build graph into .node-build.
        runTsc(['-p', 'tsconfig.tests.json'], repoRoot);
        copyUiLanguagePacksFromSource(repoRoot, buildRoot);
        copyScriptRuntimeSupportFiles(buildRoot, repoRoot);
        const generatedCliPath = syncRepoCliEntrypoint(buildRoot, repoRoot);

        const allFiles: string[] = [];

        for (const subdir of ['src', 'tests/node', 'scripts/node-foundation']) {
            const compiledRoot = path.join(buildRoot, ...subdir.split('/'));
            if (fs.existsSync(compiledRoot)) {
                for (const absPath of collectFilesByExtensions(compiledRoot, ['.js', '.json'])) {
                    allFiles.push(path.relative(buildRoot, absPath).split(path.sep).join('/'));
                }
            }
        }

        fs.writeFileSync(
            manifestPath,
            JSON.stringify({
                nodeEngineRange: getNodeEngineRange(repoRoot),
                sourceRoots: ['src', 'tests/node', 'scripts/node-foundation'],
                files: allFiles,
                inputFingerprint
            }, null, 2) + '\n',
            'utf8'
        );

        return { buildRoot, copiedFiles: allFiles, generatedCliPath, manifestPath, repoRoot };
    });
}

export function buildPublishRuntime(): BuildResult {
    const repoRoot = getRepoRoot();
    const buildRoot = path.join(repoRoot, 'dist');
    return withBuildRootLock(buildRoot, () => {
        const inputFingerprint = buildPublishRuntimeInputFingerprint(repoRoot);
        const manifestPath = path.join(buildRoot, 'publish-runtime-manifest.json');
        const cacheManifestPath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
        const reusable = checkReusableBuildRoot(
            buildRoot,
            cacheManifestPath,
            inputFingerprint,
            PUBLISH_RUNTIME_FORCE_REBUILD_ENV,
            false,
            manifestPath
        );
        printReuseDiagnostic('PUBLISH_RUNTIME_BUILD', reusable, inputFingerprint);
        if (reusable.accepted) {
            const generatedCliPath = syncRepoCliEntrypoint(buildRoot, repoRoot);
            return {
                buildRoot,
                copiedFiles: copiedFilesFromManifest(reusable.manifest),
                generatedCliPath,
                manifestPath,
                repoRoot
            };
        }

        resetBuildRoot(buildRoot);

        runTsc(['-p', 'tsconfig.build.json'], repoRoot);
        copyUiLanguagePacksFromSource(repoRoot, buildRoot);
        const generatedCliPath = syncRepoCliEntrypoint(buildRoot, repoRoot);

        const srcBuildRoot = path.join(buildRoot, 'src');
        const copiedFiles: string[] = fs.existsSync(srcBuildRoot)
            ? collectFilesByExtensions(srcBuildRoot, ['.js', '.json']).map((f: string) =>
                path.relative(buildRoot, f).split(path.sep).join('/')
            )
            : [];

        const publishedManifest = {
            nodeEngineRange: getNodeEngineRange(repoRoot),
            sourceRoots: ['src'],
            files: copiedFiles
        };
        const publishedManifestContent = JSON.stringify(publishedManifest, null, 2) + '\n';
        fs.writeFileSync(manifestPath, publishedManifestContent, 'utf8');
        fs.mkdirSync(path.dirname(cacheManifestPath), { recursive: true });
        fs.writeFileSync(cacheManifestPath, JSON.stringify({
            ...publishedManifest,
            inputFingerprint,
            publishedManifestSha256: hashText(publishedManifestContent)
        }, null, 2) + '\n', 'utf8');

        return { buildRoot, copiedFiles, generatedCliPath, manifestPath, repoRoot };
    });
}

export function runNodeFoundationBuild(): BuildResult {
    const result = buildNodeFoundation();
    console.log('NODE_FOUNDATION_BUILD_OK');
    console.log(`OutputRoot: ${path.relative(result.repoRoot, result.buildRoot).split(path.sep).join('/')}`);
    console.log(`GeneratedCliPath: ${path.relative(result.repoRoot, result.generatedCliPath).split(path.sep).join('/')}`);
    console.log(`ManifestPath: ${path.relative(result.repoRoot, result.manifestPath).split(path.sep).join('/')}`);
    console.log(`Files: ${result.copiedFiles.length}`);
    return result;
}

export function runPublishRuntimeBuild(): BuildResult {
    const result = buildPublishRuntime();
    console.log('PUBLISH_RUNTIME_BUILD_OK');
    console.log(`OutputRoot: ${path.relative(result.repoRoot, result.buildRoot).split(path.sep).join('/')}`);
    console.log(`GeneratedCliPath: ${path.relative(result.repoRoot, result.generatedCliPath).split(path.sep).join('/')}`);
    console.log(`ManifestPath: ${path.relative(result.repoRoot, result.manifestPath).split(path.sep).join('/')}`);
    console.log(`Files: ${result.copiedFiles.length}`);
    return result;
}

// CLI entry point: dispatch based on argv when run directly
if (require.main === module) {
    const command = process.argv[2];
    if (command === 'publish-runtime') {
        runPublishRuntimeBuild();
    } else if (command === 'node-foundation') {
        runNodeFoundationBuild();
    } else if (command === 'sync-repo-cli') {
        const repoCliPath = syncRepoCliFromScriptsBuild();
        console.log('REPO_CLI_SYNC_OK');
        console.log(`GeneratedCliPath: ${path.relative(getRepoRoot(), repoCliPath).split(path.sep).join('/')}`);
    } else {
        console.error(`Usage: node build.js <publish-runtime|node-foundation|sync-repo-cli>`);
        process.exit(1);
    }
}
