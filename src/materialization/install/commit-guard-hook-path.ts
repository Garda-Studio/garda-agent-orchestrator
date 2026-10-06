import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
    assertContainedDestination,
    bindContainedDestination,
    ContainedDestination
} from '../../core/contained-filesystem';
import { spawnSyncWithTimeout } from '../../core/subprocess';

const GIT_METADATA_TIMEOUT_MS = 5000;
const GIT_METADATA_MAX_BYTES = 64 * 1024;

export interface CommitGuardHookDestination {
    readonly hookPath: string;
    readonly root: string;
    readonly metadata: readonly ContainedDestination[];
    readonly binding: ContainedDestination;
    readonly metadataHashes: ReadonlyMap<string, string>;
    readonly gitProbe?: { readonly targetRoot: string; readonly gitPath: string };
}

function gitMetadata(targetRoot: string, gitPath: string, args: string[]): string {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_|$))/i.test(key)) {
            delete env[key];
        }
    }
    const result = spawnSyncWithTimeout('git', ['--git-dir', gitPath, ...args], {
        cwd: targetRoot,
        env,
        encoding: 'utf8',
        timeoutMs: GIT_METADATA_TIMEOUT_MS,
        maxBuffer: GIT_METADATA_MAX_BYTES,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Cannot resolve commit guard Git metadata: ${result.error?.message || result.stderr}`);
    }
    const value = result.stdout.replace(/\r?\n$/, '');
    if (!value || /[\r\n\0]/.test(value)) {
        throw new Error('Git returned an invalid commit guard destination.');
    }
    return path.resolve(targetRoot, value);
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function resolveCommitGuardHookDestination(targetRoot: string): CommitGuardHookDestination {
    const root = path.resolve(targetRoot);
    const gitPath = path.join(root, '.git');
    const metadata = [bindContainedDestination(root, gitPath)];
    const stat = fs.lstatSync(gitPath);
    let commonRoot = gitPath;
    let hookPath = path.join(gitPath, 'hooks', 'pre-commit');
    let gitProbe: CommitGuardHookDestination['gitProbe'];
    // Existing materialization fixtures and not-yet-initialized workspaces may
    // contain an ordinary .git directory without Git's HEAD metadata.
    if (stat.isFile() || fs.existsSync(path.join(gitPath, 'HEAD'))) {
        gitProbe = { targetRoot: root, gitPath };
        const gitRoot = gitMetadata(root, gitPath, ['rev-parse', '--absolute-git-dir']);
        commonRoot = gitMetadata(root, gitPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        for (const metadataRoot of new Set([gitRoot, commonRoot])) {
            metadata.push(bindContainedDestination(path.parse(metadataRoot).root, metadataRoot));
            for (const name of ['commondir', 'config', 'config.worktree']) {
                const filePath = path.join(metadataRoot, name);
                metadata.push(bindContainedDestination(metadataRoot, filePath));
            }
        }
        hookPath = gitMetadata(root, gitPath, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit']);
    } else if (!stat.isDirectory()) {
        throw new Error('The Git entry must be an ordinary directory or gitdir pointer file.');
    }
    const destinationRoot = isInside(commonRoot, hookPath) ? commonRoot : root;
    if (!isInside(destinationRoot, hookPath)) {
        throw new Error('Commit guard hooks must be inside the workspace or its Git metadata directory; external core.hooksPath is unsupported.');
    }
    const binding = bindContainedDestination(destinationRoot, hookPath);
    const metadataHashes = new Map<string, string>();
    for (const entry of metadata) {
        if (fs.existsSync(entry.path) && fs.lstatSync(entry.path).isFile()) {
            metadataHashes.set(entry.path, crypto.createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex'));
        }
    }
    return { hookPath, root: destinationRoot, metadata, binding, metadataHashes, gitProbe };
}

export function assertCommitGuardHookMetadata(destination: CommitGuardHookDestination): void {
    for (const binding of destination.metadata) assertContainedDestination(binding);
    for (const [filePath, digest] of destination.metadataHashes) {
        if (crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') !== digest) {
            throw new Error(`Commit guard Git metadata changed before mutation: ${filePath}`);
        }
    }
    // Git's effective configuration may also come from include/includeIf or
    // user/system files. Ask Git again instead of duplicating its include rules.
    if (destination.gitProbe) {
        const { targetRoot, gitPath } = destination.gitProbe;
        const currentHookPath = gitMetadata(targetRoot, gitPath,
            ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit']);
        if (currentHookPath !== destination.hookPath) {
            throw new Error('Commit guard Git hook destination changed before mutation.');
        }
    }
    bindContainedDestination(destination.root, destination.hookPath);
}

export function ensureCommitGuardHookExecutable(destination: CommitGuardHookDestination): void {
    if (process.platform === 'win32') return;
    assertCommitGuardHookMetadata(destination);
    const descriptor = fs.openSync(destination.hookPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(descriptor);
        const current = fs.lstatSync(destination.hookPath);
        if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== current.dev || stat.ino !== current.ino) {
            throw new Error('Commit guard hook identity changed before setting executable mode.');
        }
        fs.fchmodSync(descriptor, (stat.mode & 0o777) | 0o111);
    } finally {
        fs.closeSync(descriptor);
    }
}
