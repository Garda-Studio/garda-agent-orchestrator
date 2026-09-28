import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleNameForTarget } from '../../core/constants';
import {
    assertContainedDestination,
    assertExistingPathIdentity,
    bindContainedDestination,
    copyContainedFile,
    removeBoundContainedPath
} from '../../core/contained-filesystem';
import { PUBLIC_BUNDLE_ASSETS } from '../../core/public-bundle-assets';
import {
    isPathInsideRoot,
    isPathRealpathInsideRoot
} from '../../core/paths';
import {
    COMPILED_RUNTIME_DEPLOY_CANDIDATES,
    DEPLOY_ITEMS,
    FORBIDDEN_COMPILED_RUNTIME_DEPLOY_PATHS,
    OPTIONAL_DEPLOY_ITEMS,
    SKIPPED_ENTRY_NAMES,
    SKIPPED_FILE_SUFFIXES
} from './cli-constants';
import type { PackageJsonLike } from './cli-types';

export function normalizePathValue(value: unknown): string {
    return path.resolve(String(value || '.'));
}

export function toPosixPath(value: string): string {
    return value.replace(/\\/g, '/');
}

export function ensureDirectoryExists(directoryPath: string, label: string): void {
    if (!fs.existsSync(directoryPath)) throw new Error(`${label} not found: ${directoryPath}`);
    const stats = fs.lstatSync(directoryPath);
    if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${directoryPath}`);
}

export function resolvePathInsideRoot(
    rootPath: string,
    pathValue: string,
    label: string,
    options?: { requireFile?: boolean; allowMissing?: boolean }
): string {
    const requireFile = (options && options.requireFile) || false;
    const allowMissing = (options && options.allowMissing) || false;
    let candidatePath = String(pathValue || '').trim();
    if (!candidatePath) throw new Error(`${label} must not be empty.`);
    if (!path.isAbsolute(candidatePath)) candidatePath = path.join(rootPath, candidatePath);
    const fullPath = path.resolve(candidatePath);
    if (!isPathInsideRoot(rootPath, fullPath)) {
        throw new Error(`${label} must resolve inside target root '${rootPath}'. Resolved path: ${fullPath}`);
    }
    if (!isPathRealpathInsideRoot(rootPath, fullPath, { allowMissing })) {
        throw new Error(
            `${label} must resolve inside target root without symlink or junction escapes '${rootPath}'. ` +
            `Resolved path: ${fullPath}`
        );
    }
    if (!fs.existsSync(fullPath)) {
        if (allowMissing) return fullPath;
        throw new Error(`${label} not found: ${fullPath}`);
    }
    if (requireFile) {
        const stats = fs.lstatSync(fullPath);
        if (!stats.isFile()) throw new Error(`${label} is not a file: ${fullPath}`);
    }
    return fullPath;
}

export function getBundlePath(targetRoot: string, bundleName?: string): string {
    return path.join(targetRoot, resolveBundleNameForTarget(targetRoot, bundleName));
}

export function getAgentInitPromptPath(bundlePath: string): string {
    return path.join(bundlePath, 'AGENT_INIT_PROMPT.md');
}

export function readOptionalJsonFile(filePath: string) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return null;
        return JSON.parse(raw);
    } catch (_error) {
        return null;
    }
}

export function readPackageJson(packageRoot: string): PackageJsonLike {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as PackageJsonLike;
}

export function readBundleVersion(sourceRoot: string): string {
    const versionPath = path.join(sourceRoot, 'VERSION');
    if (fs.existsSync(versionPath)) return fs.readFileSync(versionPath, 'utf8').trim();
    return readPackageJson(sourceRoot).version;
}

function readVersionFileIfPresent(versionPath: string): string | null {
    if (!fs.existsSync(versionPath)) return null;
    const stats = fs.statSync(versionPath);
    if (!stats.isFile()) return null;
    const value = fs.readFileSync(versionPath, 'utf8').trim();
    return value || null;
}

export function resolveWorkspaceDisplayVersion(targetRoot: string, fallbackVersion?: string, bundleName?: string): string | null {
    const normalizedRoot = normalizePathValue(targetRoot);
    const bundleVersion = readVersionFileIfPresent(
        path.join(normalizedRoot, resolveBundleNameForTarget(normalizedRoot, bundleName), 'VERSION')
    );
    if (bundleVersion) return bundleVersion;
    const rootVersion = readVersionFileIfPresent(path.join(normalizedRoot, 'VERSION'));
    if (rootVersion) return rootVersion;
    return fallbackVersion || null;
}

export function shouldSkipPath(sourcePath: string): boolean {
    const entryName = path.basename(sourcePath);
    if (SKIPPED_ENTRY_NAMES.has(entryName)) return true;
    return SKIPPED_FILE_SUFFIXES.some((suffix) => entryName.endsWith(suffix));
}

function getCopyBoundaryRoot(sourcePath: string, stats: fs.Stats, bundleRoot: string | undefined): string {
    if (bundleRoot) {
        return path.resolve(bundleRoot);
    }
    return path.resolve(stats.isDirectory() ? sourcePath : path.dirname(sourcePath));
}

function readSafeSymlinkTarget(sourcePath: string, boundaryRoot: string): string {
    const linkTarget = fs.readlinkSync(sourcePath);
    const resolvedTarget = path.resolve(path.dirname(sourcePath), linkTarget);
    if (!isPathInsideRoot(boundaryRoot, resolvedTarget)) {
        throw new Error(`Refusing to copy symlink outside bundle root: ${sourcePath}`);
    }
    return linkTarget;
}

export function copyPath(sourcePath: string, destinationPath: string, bundleRoot?: string): void {
    if (shouldSkipPath(sourcePath)) return;
    const stats = fs.lstatSync(sourcePath);
    const boundaryRoot = getCopyBoundaryRoot(sourcePath, stats, bundleRoot);
    const destinationParent = path.dirname(destinationPath);
    fs.mkdirSync(destinationParent, { recursive: true });
    if (stats.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        for (const entry of fs.readdirSync(sourcePath)) {
            copyPath(path.join(sourcePath, entry), path.join(destinationPath, entry), boundaryRoot);
        }
        return;
    }
    if (stats.isSymbolicLink()) {
        const linkTarget = readSafeSymlinkTarget(sourcePath, boundaryRoot);
        fs.symlinkSync(linkTarget, destinationPath);
        return;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    try {
        fs.chmodSync(destinationPath, stats.mode);
    } catch (_error) {
        // Windows may ignore chmod for copied files.
    }
}

export function removePathIfExists(targetPath: string): void {
    if (!fs.existsSync(targetPath)) return;
    fs.rmSync(targetPath, { recursive: true, force: true });
}

export function ensureSourceItemExists(sourceRoot: string, relativePath: string): string {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(sourcePath)) throw new Error(`Bundle source asset is missing: ${relativePath}`);
    return sourcePath;
}

function copyPublicBundleAssets(sourceRoot: string, destinationRoot: string, replaceExisting: boolean): void {
    const assets = PUBLIC_BUNDLE_ASSETS.map((item) => {
        const source = bindContainedDestination(sourceRoot, path.join(sourceRoot, item));
        const destination = bindContainedDestination(destinationRoot, path.join(destinationRoot, item));
        for (const binding of [source, destination]) {
            if (!binding.missingAt && !fs.lstatSync(binding.path).isFile()) {
                throw new Error(`Public bundle asset must be an ordinary file: ${binding.path}`);
            }
        }
        return { source, destination };
    });
    for (const { source, destination } of assets) {
        assertContainedDestination(source);
        assertExistingPathIdentity(destination);
        if (!source.missingAt) {
            copyContainedFile(destinationRoot, source.path, destination.path);
            assertContainedDestination(source);
        } else if (replaceExisting) {
            removeBoundContainedPath(bindContainedDestination(destinationRoot, destination.path));
        }
    }
}

export function deployFreshBundle(sourceRoot: string, destinationPath: string): void {
    if (fs.existsSync(destinationPath)) {
        const stats = fs.lstatSync(destinationPath);
        if (!stats.isDirectory()) throw new Error(`Destination exists and is not a directory: ${destinationPath}`);
        const entries = fs.readdirSync(destinationPath);
        if (entries.length > 0) throw new Error(`Destination already exists and is not empty: ${destinationPath}`);
    }
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const relativePath of DEPLOY_ITEMS) {
        const sourcePath = ensureSourceItemExists(sourceRoot, relativePath);
        copyPath(sourcePath, path.join(destinationPath, relativePath), sourceRoot);
    }
    for (const relativePath of OPTIONAL_DEPLOY_ITEMS) {
        const sourcePath = path.join(sourceRoot, relativePath);
        if (fs.existsSync(sourcePath)) {
            copyPath(sourcePath, path.join(destinationPath, relativePath), sourceRoot);
        }
    }
    copyPublicBundleAssets(sourceRoot, destinationPath, false);
    copyCompiledRuntimeArtifacts(sourceRoot, destinationPath, { replaceExisting: false });
}

export function syncBundleItems(sourceRoot: string, destinationPath: string): void {
    if (fs.existsSync(destinationPath) && !fs.lstatSync(destinationPath).isDirectory()) {
        throw new Error(`Bundle path exists and is not a directory: ${destinationPath}`);
    }
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const relativePath of DEPLOY_ITEMS) {
        const sourcePath = ensureSourceItemExists(sourceRoot, relativePath);
        const targetPath = path.join(destinationPath, relativePath);
        removePathIfExists(targetPath);
        copyPath(sourcePath, targetPath, sourceRoot);
    }
    for (const relativePath of OPTIONAL_DEPLOY_ITEMS) {
        const sourcePath = path.join(sourceRoot, relativePath);
        const targetPath = path.join(destinationPath, relativePath);
        removePathIfExists(targetPath);
        if (fs.existsSync(sourcePath)) {
            copyPath(sourcePath, targetPath, sourceRoot);
        }
    }
    copyPublicBundleAssets(sourceRoot, destinationPath, true);
    copyCompiledRuntimeArtifacts(sourceRoot, destinationPath, { replaceExisting: true });
}

function hasCompiledRuntimeRoot(sourceRoot: string, relativePath: string): boolean {
    return fs.existsSync(path.join(sourceRoot, relativePath, 'src', 'index.js'));
}

function isRecoverableRuntimeCopyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'MODULE_NOT_FOUND';
}

function copyCompiledRuntimeArtifacts(
    sourceRoot: string,
    destinationPath: string,
    options: { replaceExisting: boolean }
): void {
    for (const relativePath of FORBIDDEN_COMPILED_RUNTIME_DEPLOY_PATHS) {
        removePathIfExists(path.join(destinationPath, relativePath));
    }

    const availableCandidates = COMPILED_RUNTIME_DEPLOY_CANDIDATES.filter((relativePath) => {
        return hasCompiledRuntimeRoot(sourceRoot, relativePath);
    });

    if (availableCandidates.length === 0) {
        throw new Error(
            'Garda runtime build output not found.\n' +
            'Run "npm run build" to compile TypeScript sources before bootstrap or install.'
        );
    }

    let lastError: unknown = null;

    for (let index = 0; index < availableCandidates.length; index += 1) {
        const relativePath = availableCandidates[index];
        const sourcePath = path.join(sourceRoot, relativePath);
        const targetPath = path.join(destinationPath, relativePath);

        try {
            if (options.replaceExisting) {
                removePathIfExists(targetPath);
            }
            copyPath(sourcePath, targetPath, sourceRoot);
            return;
        } catch (error: unknown) {
            lastError = error;
            removePathIfExists(targetPath);
            const hasFallback = index < availableCandidates.length - 1;
            if (!hasFallback || !isRecoverableRuntimeCopyError(error)) {
                throw error;
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to copy compiled runtime artifacts.');
}
