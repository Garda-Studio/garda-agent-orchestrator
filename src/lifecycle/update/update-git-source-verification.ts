import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSyncWithTimeout, DEFAULT_GIT_TIMEOUT_MS } from '../../core/subprocess';
import { BUNDLE_SYNC_ITEMS } from '../common';
import { createLifecycleDiagnosticError } from './update-diagnostics';

const REQUIRED_BUNDLE_FILES = ['VERSION', 'package.json', 'bin/garda.js', 'dist/src/index.js'];

export function createIsolatedGitEnvironment(templateRoot: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.toUpperCase().startsWith('GIT_')) delete env[key];
    }
    const emptyConfigPath = path.join(templateRoot, 'empty.gitconfig');
    fs.writeFileSync(emptyConfigPath, '', { flag: 'wx' });
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = emptyConfigPath;
    env.GIT_CONFIG_SYSTEM = emptyConfigPath;
    env.GIT_TEMPLATE_DIR = templateRoot;
    env.GIT_ALLOW_PROTOCOL = 'https:file';
    env.GIT_TERMINAL_PROMPT = '0';
    env.XDG_CONFIG_HOME = templateRoot;
    return env;
}

export function isExplicitLocalGitPath(repoUrl: string): boolean {
    const source = String(repoUrl).trim();
    return path.isAbsolute(source) || source === '.' || source === '..'
        || source.startsWith('./') || source.startsWith('../')
        || (path.sep === '\\' && (source.startsWith('.\\') || source.startsWith('..\\')));
}

export function assertGitUpdateTransport(repoUrl: string, _sourceReference: string): void {
    const source = String(repoUrl).trim();
    if (isExplicitLocalGitPath(source)) return;
    const isAllowedUrl = /^https:\/\//iu.test(source);
    if (isAllowedUrl) {
        try {
            const parsed = new URL(source);
            if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash
                && parsed.protocol === 'https:' && parsed.hostname) {
                return;
            }
        } catch (_error) {
            // Reject malformed URLs without echoing their potentially secret contents.
        }
    }
    throw createLifecycleDiagnosticError({
        message: 'Git update source must use HTTPS or an explicit local path without URL credentials or parameters.',
        tool: 'git',
        code: 'UPDATE_SOURCE_UNVERIFIED',
        sourceReference: 'git'
    });
}

function gitText(sourceRoot: string, env: NodeJS.ProcessEnv, args: string[]): string | null {
    const result = spawnSyncWithTimeout('git', args, {
        cwd: sourceRoot,
        env,
        stdio: 'pipe',
        encoding: 'utf8',
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.error || result.status !== 0 || result.timedOut) return null;
    return String(result.stdout || '').trim();
}

function rejectUnverified(sourceReference: string, detail: string): never {
    throw createLifecycleDiagnosticError({
        message: `Git update source '${sourceReference}' failed source and ref verification: ${detail}.`,
        tool: 'git',
        code: 'UPDATE_SOURCE_UNVERIFIED',
        sourceReference
    });
}

function sameSource(left: string, right: string): boolean {
    if (isExplicitLocalGitPath(left) && isExplicitLocalGitPath(right)) {
        return path.resolve(left) === path.resolve(right);
    }
    return left.replace(/\/+$/u, '').replace(/\.git$/iu, '').toLowerCase()
        === right.replace(/\/+$/u, '').replace(/\.git$/iu, '').toLowerCase();
}

function trackedRegularFiles(sourceRoot: string, env: NodeJS.ProcessEnv, sourceReference: string): Set<string> {
    const raw = gitText(sourceRoot, env, ['ls-files', '--stage', '-z']);
    if (raw === null) rejectUnverified(sourceReference, 'cannot inspect the Git index');
    const paths = new Set<string>();
    for (const entry of raw.split('\0')) {
        if (!entry) continue;
        const match = /^(100644|100755) [0-9a-f]{40,64} 0\t(.+)$/u.exec(entry);
        if (!match) rejectUnverified(sourceReference, 'the Git tree contains a link, submodule, or unresolved index entry');
        paths.add(match[2]);
    }
    return paths;
}

function verifySyncSurface(sourceRoot: string, tracked: Set<string>, sourceReference: string): void {
    const visit = (relativePath: string): void => {
        const absolutePath = path.join(sourceRoot, relativePath);
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) rejectUnverified(sourceReference, 'a bundle path is a symbolic link');
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(absolutePath)) {
                visit(path.posix.join(relativePath.replaceAll('\\', '/'), name));
            }
            return;
        }
        if (!stat.isFile() || !tracked.has(relativePath.replaceAll('\\', '/'))) {
            rejectUnverified(sourceReference, 'the bundle contains a non-regular or untracked file');
        }
    };
    for (const item of BUNDLE_SYNC_ITEMS) {
        if (fs.existsSync(path.join(sourceRoot, item))) visit(item);
    }
}

export function verifyGitUpdateSource(input: {
    sourceRoot: string;
    repoUrl: string;
    branch: string | null;
    sourceReference: string;
    env: NodeJS.ProcessEnv;
    requireBundle: boolean;
}): string {
    const { sourceRoot, repoUrl, branch, sourceReference, env, requireBundle } = input;
    const origin = gitText(sourceRoot, env, ['remote', 'get-url', 'origin']);
    if (!origin || !sameSource(origin, repoUrl)) rejectUnverified(sourceReference, 'remote origin differs from the requested source');

    const commit = gitText(sourceRoot, env, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!commit || !/^[0-9a-f]{40,64}$/u.test(commit)) rejectUnverified(sourceReference, 'HEAD is not a valid commit');
    if (branch) {
        const refs = [`refs/heads/${branch}^{commit}`, `refs/tags/${branch}^{commit}`];
        if (!refs.some((ref) => gitText(sourceRoot, env, ['rev-parse', '--verify', ref]) === commit)) {
            rejectUnverified(sourceReference, 'the checked-out commit differs from the requested ref');
        }
    }
    const status = gitText(sourceRoot, env, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status === null || status) rejectUnverified(sourceReference, 'the checked-out tree is not clean');
    const tracked = trackedRegularFiles(sourceRoot, env, sourceReference);
    if (!tracked.has('VERSION')) rejectUnverified(sourceReference, 'VERSION is not tracked by the selected commit');

    if (requireBundle) {
        for (const required of REQUIRED_BUNDLE_FILES) {
            if (!tracked.has(required) || !fs.existsSync(path.join(sourceRoot, required))) {
                throw createLifecycleDiagnosticError({
                    message: `Git update source '${sourceReference}' has no complete prebuilt bundle in the selected commit.`,
                    tool: 'git',
                    code: 'UPDATE_SOURCE_PREBUILT_REQUIRED',
                    sourceReference,
                    detailText: `Missing tracked file: ${required}`
                });
            }
        }
        verifySyncSurface(sourceRoot, tracked, sourceReference);
        const version = fs.readFileSync(path.join(sourceRoot, 'VERSION'), 'utf8').trim();
        let packageVersion: string | undefined;
        try {
            packageVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
        } catch (_error) {
            rejectUnverified(sourceReference, 'package.json is invalid');
        }
        if (!version || packageVersion !== version) rejectUnverified(sourceReference, 'VERSION and package.json version differ');
    }
    return commit;
}
