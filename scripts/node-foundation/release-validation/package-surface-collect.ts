import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readPackedTarball, type PackedFile, type PackedTarball } from './package-surface-tar';
import {
    PACKAGE_SURFACE_LIFECYCLE_SCRIPTS,
    PACKAGE_SURFACE_RISK_SIGNALS,
    PACKAGE_SURFACE_SCHEMA_VERSION,
    type NpmPackFile,
    type NpmPackReport,
    type PackageSurfaceArtifact,
    type PackageSurfaceRiskSignals
} from './package-surface-types';

const EXECUTABLE_SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts']);
const NPM_PACK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const RISK_SIGNAL_PATTERNS: Readonly<Record<keyof PackageSurfaceRiskSignals, RegExp>> = Object.freeze({
    child_process: /child_process/gu,
    exec: /\bexec(?:File)?(?:Sync)?\b/gu,
    fetch: /\bfetch\b/gu,
    fs: /node:fs|\brequire\s*\(\s*['"]fs(?:\/promises)?['"]\s*\)|\bfrom\s*['"]fs(?:\/promises)?['"]|\bimport\s*(?:\(\s*)?['"]fs(?:\/promises)?['"]\s*\)?|\bfs\s*\./gu,
    readFile: /\breadFile(?:Sync)?\b/gu,
    writeFile: /\bwriteFile(?:Sync)?\b/gu
});

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label}.${key} must be a non-empty string.`);
    }
    return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number {
    const value = record[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`${label}.${key} must be a non-negative safe integer.`);
    }
    return Number(value);
}

function emptyRiskSignals(): PackageSurfaceRiskSignals {
    return {
        child_process: 0,
        exec: 0,
        fetch: 0,
        fs: 0,
        readFile: 0,
        writeFile: 0
    };
}

function normalizePackPath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/gu, '/');
    const segments = normalized.split('/');
    const unsafe = normalized !== relativePath
        || path.posix.isAbsolute(normalized)
        || segments.some((segment) => !segment || segment === '.' || segment === '..');
    if (unsafe) {
        throw new Error(`npm pack reported unsafe packed file path: ${relativePath}`);
    }
    return normalized;
}

function parsePackFile(value: unknown, index: number): NpmPackFile {
    if (!isRecord(value)) {
        throw new Error(`npm pack report.files[${index}] must be an object.`);
    }
    return {
        path: requireString(value, 'path', `npm pack report.files[${index}]`),
        size: requireNonNegativeInteger(value, 'size', `npm pack report.files[${index}]`)
    };
}

function parsePackReportValue(value: unknown): NpmPackReport {
    if (!isRecord(value)) {
        throw new Error('npm pack report must be an object.');
    }
    if (!Array.isArray(value.files)) {
        throw new Error('npm pack report.files must be an array.');
    }
    return {
        name: requireString(value, 'name', 'npm pack report'),
        version: requireString(value, 'version', 'npm pack report'),
        filename: requireString(value, 'filename', 'npm pack report'),
        entryCount: requireNonNegativeInteger(value, 'entryCount', 'npm pack report'),
        unpackedSize: requireNonNegativeInteger(value, 'unpackedSize', 'npm pack report'),
        files: value.files.map(parsePackFile)
    };
}

function findJsonArrayEnd(value: string, start: number): number | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if (character === '[') {
            depth += 1;
        } else if (character === ']') {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    return null;
}

function findJsonArrayCandidates(value: string): unknown[][] {
    const candidates: unknown[][] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== '[' || (index > 0 && value[index - 1] !== '\n' && value[index - 1] !== '\r')) {
            continue;
        }
        const end = findJsonArrayEnd(value, index);
        if (end === null) {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(value.slice(index, end));
            if (Array.isArray(parsed)) {
                candidates.push(parsed);
            }
        } catch {
            // Non-JSON lifecycle output is ignored; the final report remains mandatory.
        }
    }
    return candidates;
}

export function parseNpmPackReport(stdout: string): NpmPackReport {
    const candidates = findJsonArrayCandidates(String(stdout || ''));
    if (candidates.length === 0) {
        throw new Error('npm pack output did not contain a valid npm pack JSON array.');
    }
    if (candidates.length !== 1 || candidates[0].length !== 1) {
        throw new Error('npm pack output must contain exactly one final package report.');
    }
    return parsePackReportValue(candidates[0][0]);
}

function validatePackReportConsistency(report: NpmPackReport): void {
    if (report.entryCount !== report.files.length) {
        throw new Error(`npm pack entryCount=${report.entryCount} does not match files.length=${report.files.length}.`);
    }
    const totalSize = report.files.reduce((sum, file) => sum + file.size, 0);
    if (report.unpackedSize !== totalSize) {
        throw new Error(`npm pack unpackedSize=${report.unpackedSize} does not match summed file size=${totalSize}.`);
    }
    const paths = report.files.map((file) => normalizePackPath(file.path));
    if (new Set(paths).size !== paths.length) {
        throw new Error('npm pack report contains duplicate file paths.');
    }
}

function readPackageIdentityAndScripts(tarball: PackedTarball): {
    name: string;
    version: string;
    scripts: Record<string, string>;
    manifest: Record<string, unknown>;
} {
    const packedManifest = tarball.files.find((file) => file.path === 'package.json');
    if (!packedManifest) {
        throw new Error('Packed tarball is missing package.json.');
    }
    const payload: unknown = JSON.parse(packedManifest.content.toString('utf8'));
    if (!isRecord(payload)) {
        throw new Error('package.json must contain an object.');
    }
    const scripts: Record<string, string> = {};
    if (isRecord(payload.scripts)) {
        for (const [name, command] of Object.entries(payload.scripts)) {
            if (typeof command === 'string') {
                scripts[name] = command;
            }
        }
    }
    return {
        name: requireString(payload, 'name', 'package.json'),
        version: requireString(payload, 'version', 'package.json'),
        scripts,
        manifest: payload
    };
}

function collectLifecycleScripts(scripts: Record<string, string>): Record<string, string> {
    const lifecycleScripts: Record<string, string> = {};
    for (const name of [...PACKAGE_SURFACE_LIFECYCLE_SCRIPTS].sort()) {
        if (Object.hasOwn(scripts, name)) {
            lifecycleScripts[name] = scripts[name];
        }
    }
    return lifecycleScripts;
}

function collectRiskSignals(files: PackedFile[]): PackageSurfaceRiskSignals {
    const counts = emptyRiskSignals();
    for (const file of files) {
        if (!EXECUTABLE_SOURCE_EXTENSIONS.has(path.extname(file.path).toLowerCase())) {
            continue;
        }
        const content = file.content.toString('utf8');
        for (const signal of PACKAGE_SURFACE_RISK_SIGNALS) {
            counts[signal] += [...content.matchAll(RISK_SIGNAL_PATTERNS[signal])].length;
        }
    }
    return counts;
}

function hashPackedFileManifest(files: PackedFile[]): string {
    const hash = crypto.createHash('sha256');
    const sortedFiles = [...files].sort((left, right) => compareText(left.path, right.path));
    for (const file of sortedFiles) {
        hash.update(normalizePackPath(file.path));
        hash.update('\0');
        hash.update(String(file.size));
        hash.update('\0');
        hash.update(file.sha256);
        hash.update('\n');
    }
    return hash.digest('hex');
}

function requireStringMap(value: unknown, label: string): Record<string, string> {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    for (const [name, item] of entries) {
        if (typeof item !== 'string' || !item.trim()) {
            throw new Error(`${label}.${name} must be a non-empty string.`);
        }
    }
    return Object.fromEntries(entries) as Record<string, string>;
}

function requireUrlField(value: unknown, label: string): string {
    const url = typeof value === 'string' ? value : isRecord(value) ? value.url : undefined;
    if (typeof url !== 'string' || !/^https?:\/\//iu.test(url.replace(/^git\+/iu, ''))) {
        throw new Error(`Packed package.json ${label} must be an HTTP(S) URL.`);
    }
    return url;
}

function collectUrlHosts(files: PackedFile[]): string[] {
    const hosts = new Set<string>();
    for (const file of files) {
        if (file.content.includes(0)) {
            continue;
        }
        for (const match of file.content.toString('utf8').matchAll(/https?:\/\/[^\s"'<>`\\]+/giu)) {
            try {
                const host = new URL(match[0]).hostname.toLowerCase();
                if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)) {
                    hosts.add(host);
                }
            } catch {
                // Prose and template placeholders are not concrete URL hosts.
            }
        }
    }
    return [...hosts].sort(compareText);
}

export function buildPackageSurfaceArtifact(tarball: PackedTarball, report: NpmPackReport, installedSizeBytes: number): PackageSurfaceArtifact {
    validatePackReportConsistency(report);
    const packageJson = readPackageIdentityAndScripts(tarball);
    if (packageJson.name !== report.name || packageJson.version !== report.version) {
        throw new Error(
            `npm pack identity ${report.name}@${report.version} does not match package.json ${packageJson.name}@${packageJson.version}.`
        );
    }
    const reported = new Map(report.files.map((file) => [normalizePackPath(file.path), file.size]));
    if (reported.size !== tarball.files.length) {
        throw new Error(`npm pack report lists ${reported.size} files but tarball contains ${tarball.files.length}.`);
    }
    for (const file of tarball.files) {
        if (reported.get(file.path) !== file.size) {
            throw new Error(`npm pack report does not match tarball file ${file.path}: report=${reported.get(file.path)} tarball=${file.size}.`);
        }
    }
    const unpackedSizeBytes = tarball.files.reduce((sum, file) => sum + file.size, 0);
    if (unpackedSizeBytes !== report.unpackedSize) {
        throw new Error(`npm pack report unpackedSize=${report.unpackedSize} differs from tarball=${unpackedSizeBytes}.`);
    }
    const manifest = packageJson.manifest;
    const bin = requireStringMap(manifest.bin, 'package.json.bin');
    for (const binPath of Object.values(bin)) {
        if (!tarball.files.some((file) => file.path === binPath)) {
            throw new Error(`Packed package.json bin target is missing: ${binPath}`);
        }
    }
    const dependencyNames = new Set<string>();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        if (manifest[field] !== undefined) {
            for (const name of Object.keys(requireStringMap(manifest[field], `package.json.${field}`))) {
                dependencyNames.add(name);
            }
        }
    }
    const expectedExecutables = new Set(Object.values(bin).flatMap((binPath) => [binPath, `dist/src/${binPath}`]));
    const unexpectedExecutablePaths = tarball.files.filter((file) =>
        ((file.mode & 0o111) !== 0 || file.content.subarray(0, 2).toString() === '#!')
        && !expectedExecutables.has(file.path)
    ).map((file) => file.path).sort(compareText);
    const minifiedArtifactPaths = tarball.files.filter((file) =>
        /\.min\.(?:css|js)$/iu.test(file.path)
        || ((EXECUTABLE_SOURCE_EXTENSIONS.has(path.extname(file.path).toLowerCase())
            || path.extname(file.path).toLowerCase() === '.css')
            && file.content.toString('utf8').split(/\r?\n/u).some((line) => line.length > 10_000))
    ).map((file) => file.path).sort(compareText);
    if (!Number.isSafeInteger(installedSizeBytes) || installedSizeBytes < 0) {
        throw new Error('Installed package byte count must be a non-negative safe integer.');
    }
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: { name: report.name, version: report.version },
        packedFileManifestSha256: hashPackedFileManifest(tarball.files),
        tarballSha256: tarball.sha256,
        packedFileSha256: Object.fromEntries(tarball.files.map((file) => [file.path, file.sha256]).sort(([left], [right]) => compareText(left, right))),
        metrics: {
            fileCount: tarball.files.length,
            unpackedSizeBytes,
            installedSizeBytes,
            productionDependencyCount: dependencyNames.size,
            lifecycleScripts: collectLifecycleScripts(packageJson.scripts),
            unexpectedExecutablePaths,
            minifiedArtifactPaths,
            urlHosts: collectUrlHosts(tarball.files),
            metadata: {
                description: requireString(manifest, 'description', 'package.json'),
                author: requireString(manifest, 'author', 'package.json'),
                license: requireString(manifest, 'license', 'package.json'),
                type: requireString(manifest, 'type', 'package.json'),
                repository: requireUrlField(manifest.repository, 'repository'),
                homepage: requireUrlField(manifest.homepage, 'homepage'),
                bugs: requireUrlField(manifest.bugs, 'bugs'),
                funding: requireUrlField(manifest.funding, 'funding'),
                bin,
                engines: requireStringMap(manifest.engines, 'package.json.engines')
            },
            riskSignals: collectRiskSignals(tarball.files)
        }
    };
}

function formatProcessFailure(label: string, result: childProcess.SpawnSyncReturns<string>): Error {
    const details = [result.error?.message, String(result.stderr || '').trim(), String(result.stdout || '').trim()]
        .filter(Boolean)
        .join('\n');
    return new Error(`${label} failed${details ? `:\n${details}` : '.'}`);
}

function runRequiredProcess(repoRoot: string, label: string, command: string, args: string[]): string {
    const result = childProcess.spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: NPM_PACK_MAX_BUFFER_BYTES,
        env: { ...process.env, npm_config_cache: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'npm-cache') },
        windowsHide: true
    });
    if (result.status !== 0 || result.error) {
        throw formatProcessFailure(label, result);
    }
    return String(result.stdout || '');
}

function preparePackageSurface(repoRoot: string): void {
    runRequiredProcess(
        repoRoot,
        'publish-runtime build for package-surface measurement',
        process.execPath,
        [path.join('.scripts-build', 'scripts', 'node-foundation', 'build.js'), 'publish-runtime']
    );
    runRequiredProcess(
        repoRoot,
        'legacy package compatibility materialization',
        process.execPath,
        ['scripts/package-legacy-entrypoint-compat.cjs', 'create']
    );
}

function removePackageSurfaceCompatibilityFile(repoRoot: string): void {
    runRequiredProcess(
        repoRoot,
        'legacy package compatibility cleanup',
        process.execPath,
        ['scripts/package-legacy-entrypoint-compat.cjs', 'remove']
    );
}

function resolveNpmInvocation(): { command: string; argsPrefix: string[] } {
    const npmExecPath = String(process.env.npm_execpath || '').trim();
    const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmCliPath = npmExecPath && fs.existsSync(npmExecPath) ? npmExecPath : bundledNpmCli;
    if (fs.existsSync(npmCliPath)) {
        return { command: process.execPath, argsPrefix: [npmCliPath] };
    }
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', argsPrefix: [] };
}

export function installedPackageBytes(directory: string): number {
    let bytes = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            bytes += installedPackageBytes(entryPath);
        } else if (entry.isFile()) {
            bytes += fs.statSync(entryPath).size;
        } else if (entry.isSymbolicLink()) {
            bytes += fs.lstatSync(entryPath).size;
        } else {
            throw new Error(`Installed package contains an unsupported file type: ${entryPath}`);
        }
    }
    return bytes;
}

function runNpmPack(repoRoot: string): PackageSurfaceArtifact {
    const npmInvocation = resolveNpmInvocation();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-package-surface-'));
    let artifact: PackageSurfaceArtifact | null = null;
    let packError: unknown = null;
    try {
        preparePackageSurface(repoRoot);
        const stdout = runRequiredProcess(
            repoRoot,
            'npm pack',
            npmInvocation.command,
            [...npmInvocation.argsPrefix, 'pack', '--pack-destination', scratch, '--json', '--silent', '--ignore-scripts']
        );
        const report = parseNpmPackReport(stdout);
        if (path.basename(report.filename) !== report.filename || !report.filename.endsWith('.tgz')) {
            throw new Error(`npm pack reported an unsafe tarball filename: ${report.filename}`);
        }
        const tarballPath = path.join(scratch, report.filename);
        const tarball = readPackedTarball(tarballPath);
        const installRoot = path.join(scratch, 'install');
        runRequiredProcess(
            repoRoot,
            'offline installation of the exact npm pack tarball',
            npmInvocation.command,
            [...npmInvocation.argsPrefix, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
                '--package-lock=false', '--prefix', installRoot, tarballPath]
        );
        const packageDir = path.join(installRoot, 'node_modules', report.name);
        if (!fs.statSync(packageDir).isDirectory()) {
            throw new Error(`Offline install omitted the packed package: ${report.name}`);
        }
        const installedSizeBytes = installedPackageBytes(path.join(installRoot, 'node_modules'));
        artifact = buildPackageSurfaceArtifact(tarball, report, installedSizeBytes);
    } catch (error: unknown) {
        packError = error;
    }
    let cleanupError: unknown = null;
    try {
        removePackageSurfaceCompatibilityFile(repoRoot);
    } catch (error: unknown) {
        cleanupError = error;
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    if (cleanupError !== null) {
        if (packError instanceof Error) {
            throw new Error(`${packError.message}\n${String(cleanupError)}`);
        }
        throw cleanupError;
    }
    if (packError !== null) {
        throw packError;
    }
    if (artifact === null) {
        throw new Error('npm pack completed without a package-surface artifact.');
    }
    return artifact;
}

export function collectCurrentPackageSurface(repoRoot: string): PackageSurfaceArtifact {
    const normalizedRoot = path.resolve(repoRoot);
    return runNpmPack(normalizedRoot);
}
