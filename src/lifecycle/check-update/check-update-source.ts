import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIMARY_PACKAGE_NAME } from '../../core/constants';
import {
    assertContainedDestination,
    bindContainedDestination,
    ensureContainedDirectory,
    removeBoundContainedPath,
    type ContainedDestination
} from '../../core/contained-filesystem';
import { pathExists, readTextFile } from '../../core/filesystem';
import {
    DEFAULT_NPM_TIMEOUT_MS,
    spawnStreamed,
    spawnSyncWithTimeout,
    type SpawnStreamedOptions,
    type SpawnSyncWithTimeoutOptions
} from '../../core/subprocess';
import { compareVersionStrings } from '../common';
import { classifyNpmDiagnostic, createLifecycleDiagnosticError } from '../update/update-diagnostics';
import {
    buildReleaseUpdateProvenance,
    parseNpmPackageSpec,
    validateNpmSourceTrust,
    validatePathSourceTrust
} from '../update/update-trust';
import {
    type AcquireUpdateSourceOptions,
    type AcquiredUpdateSource,
    type NpmInstallResult,
    type ResolveInstalledPackageRootOptions,
    type ResolvedNpmUpdateSource,
    type ResolveNpmUpdateSourceSpecOptions
} from './check-update-types';
import { getErrorMessage, toObjectRecord } from './check-update-utils';

export const DEFAULT_PACKAGE_NAME = PRIMARY_PACKAGE_NAME;
export const DEFAULT_UPDATE_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
const ownedUpdateTempRoots = new Map<string, ContainedDestination>();

interface NpmInvocation {
    command: string;
    prefixArgs: string[];
}

function buildNpmInstallFailureDiagnostic(
    installResult: NpmInstallResult,
    effectivePackageSpec: string,
    effectiveDiagnosticSource: string
): Error | null {
    if (installResult.cancelled) {
        return createLifecycleDiagnosticError({
            message: `npm install was cancelled for '${effectivePackageSpec}'.`,
            tool: 'npm',
            code: 'NPM_INSTALL_CANCELLED',
            sourceReference: effectiveDiagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }

    if (installResult.timedOut) {
        return createLifecycleDiagnosticError({
            message: `npm install timed out after ${DEFAULT_NPM_TIMEOUT_MS} ms for '${effectivePackageSpec}'.`,
            tool: 'npm',
            code: 'NPM_INSTALL_TIMEOUT',
            sourceReference: effectiveDiagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }

    if (installResult.exitCode !== 0) {
        const diagnosticText = `${String(installResult.stderr || '')}\n${String(installResult.stdout || '')}`;
        return createLifecycleDiagnosticError({
            message: `Failed to install update package '${effectivePackageSpec}'.`,
            tool: 'npm',
            code: classifyNpmDiagnostic(diagnosticText),
            sourceReference: effectiveDiagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }

    return null;
}

function isExactNpmVersion(version: string | null): boolean {
    return typeof version === 'string'
        && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version.trim());
}

function selectNpmViewRecord(parsed: unknown, sourceReference: string, stdout: string): Record<string, unknown> {
    if (Array.isArray(parsed)) {
        const records = parsed
            .map((entry) => toObjectRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null);
        if (records.length === 0) {
            throw createLifecycleDiagnosticError({
                message: `npm metadata for update package '${sourceReference}' did not contain any usable version records.`,
                tool: 'npm',
                code: 'NPM_METADATA_INVALID',
                sourceReference,
                stdout
            });
        }

        const sorted = records
            .map((record) => ({
                record,
                version: String(record.version || '').trim()
            }))
            .sort((left, right) => compareVersionStrings(left.version, right.version));
        return sorted[sorted.length - 1].record;
    }

    const record = toObjectRecord(parsed);
    if (!record) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata for update package '${sourceReference}' was ambiguous.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    return record;
}

function parseNpmViewJson(stdout: string, sourceReference: string): { version: string; integrity: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (_error) {
        throw createLifecycleDiagnosticError({
            message: `Failed to parse npm metadata for update package '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    const record = selectNpmViewRecord(parsed, sourceReference, stdout);

    const version = String(record.version || '').trim();
    const integrity = String(record['dist.integrity'] || '').trim();
    if (!version || !isExactNpmVersion(version)) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata did not resolve an exact version for update package '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    if (!integrity) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata did not include dist.integrity for update package '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    return { version, integrity };
}

let resolvedNpmInvocation: NpmInvocation | null = null;

function resolveNpmInvocation(): NpmInvocation {
    if (resolvedNpmInvocation) {
        return resolvedNpmInvocation;
    }

    const npmExecPath = String(process.env.npm_execpath || '').trim();
    if (npmExecPath && pathExists(npmExecPath)) {
        resolvedNpmInvocation = {
            command: process.execPath,
            prefixArgs: [npmExecPath]
        };
        return resolvedNpmInvocation;
    }

    const bundledCandidates = [
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];

    for (const candidate of bundledCandidates) {
        const resolvedCandidate = path.resolve(candidate);
        if (pathExists(resolvedCandidate)) {
            resolvedNpmInvocation = {
                command: process.execPath,
                prefixArgs: [resolvedCandidate]
            };
            return resolvedNpmInvocation;
        }
    }

    resolvedNpmInvocation = {
        command: 'npm',
        prefixArgs: []
    };
    return resolvedNpmInvocation;
}

function runNpmSync(args: string[], options: SpawnSyncWithTimeoutOptions = {}) {
    const {
        encoding = 'utf8',
        stdio = 'pipe'
    } = options;

    const invocation = resolveNpmInvocation();

    return spawnSyncWithTimeout(invocation.command, [...invocation.prefixArgs, ...args], {
        ...options,
        encoding,
        stdio,
        windowsHide: true,
        timeoutMs: DEFAULT_NPM_TIMEOUT_MS
    });
}

async function runNpmStreamed(args: string[], options: SpawnStreamedOptions = {}) {
    const invocation = resolveNpmInvocation();
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_NPM_TIMEOUT_MS;

    return spawnStreamed(invocation.command, [...invocation.prefixArgs, ...args], {
        cwd: options.cwd,
        timeoutMs,
        signal: options.signal ?? undefined,
        onStdout: options.onStdout ?? undefined,
        onStderr: options.onStderr ?? undefined
    });
}

export function resolveNpmUpdateSourceSpec(
    requestedSpec: string,
    options: ResolveNpmUpdateSourceSpecOptions = {}
): ResolvedNpmUpdateSource {
    const requested = String(requestedSpec || '').trim();
    const parsed = parseNpmPackageSpec(requested);
    if (!parsed || !parsed.name) {
        return {
            requestedSpec: requested,
            exactSpec: requested,
            packageName: null,
            version: null,
            integrity: null,
            resolutionMode: 'direct'
        };
    }

    const exactRequested = isExactNpmVersion(parsed.version);
    const lookupSpec = parsed.version ? `${parsed.name}@${parsed.version}` : parsed.name;
    const sourceReference = String(options.sourceReference || lookupSpec);
    const viewRunner = options.viewRunner || ((args: string[]) => runNpmSync(args));
    const viewResult = viewRunner(['view', lookupSpec, 'version', 'dist.integrity', '--json']);
    const detailText = viewResult.error ? getErrorMessage(viewResult.error) : '';
    if (viewResult.error || viewResult.status !== 0) {
        throw createLifecycleDiagnosticError({
            message: `Failed to resolve update package '${lookupSpec}' to an exact npm version.`,
            tool: 'npm',
            code: 'NPM_METADATA_UNAVAILABLE',
            sourceReference,
            stderr: viewResult.stderr,
            stdout: viewResult.stdout,
            detailText
        });
    }

    const stdout = String(viewResult.stdout || '').trim();
    if (!stdout) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata was empty for update package '${lookupSpec}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_EMPTY',
            sourceReference
        });
    }

    const metadata = parseNpmViewJson(stdout, sourceReference);
    if (exactRequested && parsed.version !== metadata.version) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata version '${metadata.version}' did not match requested update package version '${parsed.version}' for '${lookupSpec}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    return {
        requestedSpec: requested,
        exactSpec: `${parsed.name}@${metadata.version}`,
        packageName: parsed.name,
        version: metadata.version,
        integrity: metadata.integrity,
        resolutionMode: exactRequested ? 'explicit_exact' : 'resolved'
    };
}

function readPackageNameFromDirectory(directoryPath: string, fallbackValue: string | null = null): string | null {
    const packageJsonPath = path.join(directoryPath, 'package.json');
    if (!pathExists(packageJsonPath)) {
        return fallbackValue;
    }

    try {
        const parsed = toObjectRecord(JSON.parse(readTextFile(packageJsonPath)));
        const name = String(parsed && parsed.name ? parsed.name : '').trim();
        return name || fallbackValue;
    } catch (_error) {
        return fallbackValue;
    }
}

function resolveNodeModulesPackageRoot(nodeModulesRoot: string, packageName: string): string {
    return path.join(nodeModulesRoot, ...packageName.split('/'));
}

function resolveInstalledPackageRoot(
    tempInstallRoot: string,
    options: ResolveInstalledPackageRootOptions = {}
): { packageName: string; packageRoot: string } {
    const listResult = runNpmSync([
        'ls',
        '--json',
        '--depth=0',
        '--prefix',
        tempInstallRoot
    ]);

    const sourceReference = String(options.sourceReference || tempInstallRoot);
    const detailText = listResult.error ? getErrorMessage(listResult.error) : '';
    if (listResult.error || listResult.status !== 0) {
        throw createLifecycleDiagnosticError({
            message: `Failed to inspect installed update package metadata for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_UNAVAILABLE',
            sourceReference,
            stderr: listResult.stderr,
            stdout: listResult.stdout,
            detailText
        });
    }

    const stdout = String(listResult.stdout || '').trim();
    if (!stdout) {
        throw createLifecycleDiagnosticError({
            message: `Failed to resolve installed update package metadata for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_EMPTY',
            sourceReference,
            stderr: listResult.stderr,
            stdout: listResult.stdout
        });
    }

    let parsed: Record<string, unknown> = {};
    try {
        parsed = toObjectRecord(JSON.parse(stdout)) || {};
    } catch (_error) {
        throw createLifecycleDiagnosticError({
            message: `Failed to parse installed update package metadata for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    const dependencyMap = toObjectRecord(parsed.dependencies) || {};
    const dependencyNames = Object.keys(dependencyMap);
    if (dependencyNames.length === 0) {
        throw createLifecycleDiagnosticError({
            message: `Installed update package metadata did not contain any top-level dependencies for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    const packageName = dependencyNames[0];
    const packageRoot = resolveNodeModulesPackageRoot(path.join(tempInstallRoot, 'node_modules'), packageName);
    if (!pathExists(packageRoot)) {
        throw createLifecycleDiagnosticError({
            message: `Installed update package root not found for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            detailText: packageRoot
        });
    }

    return {
        packageName,
        packageRoot
    };
}

export function getUpdateTempRoot(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'update-temp');
}

export function cleanupOldUpdateTempRoots(
    runtimeRoot: string,
    ttlMs: number = DEFAULT_UPDATE_TEMP_TTL_MS,
    nowMs: number = Date.now()
): string[] {
    const updateTempRoot = getUpdateTempRoot(runtimeRoot);
    const ownerRoot = path.dirname(path.resolve(runtimeRoot));
    const updateTempBinding = bindContainedDestination(ownerRoot, updateTempRoot);
    if (updateTempBinding.missingAt) return [];
    assertContainedDestination(updateTempBinding);

    const removed: string[] = [];
    for (const entry of fs.readdirSync(updateTempRoot, { withFileTypes: true })) {
        assertContainedDestination(updateTempBinding);
        if (!entry.name.startsWith('npm-')) continue;

        const candidatePath = path.join(updateTempRoot, entry.name);
        assertContainedDestination(updateTempBinding);
        if (!entry.isDirectory()) continue;
        const candidate = ownedUpdateTempRoots.get(candidatePath);
        if (candidate) assertContainedDestination(candidate);
        const stats = fs.lstatSync(candidatePath);
        if (!stats.isDirectory()) {
            throw new Error(`Update temporary cleanup owner changed before inspection: ${candidatePath}`);
        }
        if (nowMs - stats.mtimeMs <= ttlMs) {
            continue;
        }
        if (!candidate) {
            process.stderr.write(`Preserving ambiguous update temporary root ${candidatePath}: no creator-owned binding; inspect before manual removal.\n`);
            continue;
        }

        removeBoundContainedPath(candidate, true);
        ownedUpdateTempRoots.delete(candidatePath);
        removed.push(candidatePath);
    }

    return removed;
}

export async function acquireUpdateSource(options: AcquireUpdateSourceOptions): Promise<AcquiredUpdateSource> {
    const {
        deployedBundleRoot,
        packageSpec,
        sourcePath,
        trustOverride = false,
        signal = null,
        onProgress = null,
        diagnosticSourceReference = null,
        diagnosticTool = null,
        prevalidatedPathTrustResult = null,
        npmViewRunner = null,
        npmInstallRunner = null,
        installedPackageRootResolver = null
    } = options;

    if (packageSpec && sourcePath) {
        throw new Error('Provide either packageSpec or sourcePath for check-update, not both.');
    }

    if (sourcePath) {
        const trustResult = prevalidatedPathTrustResult || validatePathSourceTrust(sourcePath, { trustOverride });
        const resolvedSourcePath = path.resolve(String(sourcePath).trim());
        if (!pathExists(resolvedSourcePath)) {
            throw new Error(`Update source path not found: ${resolvedSourcePath}`);
        }

        const stats = fs.lstatSync(resolvedSourcePath);
        if (!stats.isDirectory()) {
            throw new Error(`Update source path must be a directory: ${resolvedSourcePath}`);
        }
        const provenance = buildReleaseUpdateProvenance({
            sourceType: diagnosticTool === 'git' ? 'git' : 'path',
            sourceReference: diagnosticSourceReference || resolvedSourcePath,
            trustPolicy: trustResult.policy,
            trustOverrideUsed: trustResult.overridden,
            requestedPackageSpec: null,
            exactPackageSpec: null,
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: null
        });

        return {
            sourceType: 'path',
            sourceReference: resolvedSourcePath,
            diagnosticSourceReference: diagnosticSourceReference || resolvedSourcePath,
            packageSpec: null,
            requestedPackageSpec: null,
            exactPackageSpec: null,
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: null,
            releaseProvenanceStatus: provenance.releaseProvenanceStatus,
            releaseProvenanceSummary: provenance.releaseProvenanceSummary,
            releaseProvenanceRecommendation: provenance.releaseProvenanceRecommendation,
            packageName: readPackageNameFromDirectory(resolvedSourcePath),
            sourceRoot: resolvedSourcePath,
            trustPolicy: trustResult.policy,
            trustOverrideUsed: trustResult.overridden,
            trustOverrideSource: trustResult.overrideSource || 'none',
            diagnosticTool: diagnosticTool || 'path',
            cleanup() {}
        };
    }

    const versionResult = runNpmSync(['--version'], { stdio: 'pipe' });
    const versionDetailText = versionResult.error ? getErrorMessage(versionResult.error) : '';
    if (versionResult.error || versionResult.status !== 0) {
        throw createLifecycleDiagnosticError({
            message: 'npm is required for npm-based check-update workflow.',
            tool: 'npm',
            code: 'NPM_NOT_AVAILABLE',
            sourceReference: diagnosticSourceReference || 'npm',
            stderr: versionResult.stderr,
            stdout: versionResult.stdout,
            detailText: versionDetailText
        });
    }

    const deployedPackageName = readPackageNameFromDirectory(deployedBundleRoot, DEFAULT_PACKAGE_NAME) || DEFAULT_PACKAGE_NAME;
    const effectivePackageSpec = String(packageSpec || `${deployedPackageName}@latest`).trim();
    const effectiveDiagnosticSource = diagnosticSourceReference || effectivePackageSpec;

    const trustResult = validateNpmSourceTrust(effectivePackageSpec, { trustOverride });
    const resolvedPackageSpec = resolveNpmUpdateSourceSpec(effectivePackageSpec, {
        sourceReference: effectiveDiagnosticSource,
        viewRunner: npmViewRunner
    });
    const installPackageSpec = resolvedPackageSpec.exactSpec || effectivePackageSpec;

    const runtimeRoot = path.join(deployedBundleRoot, 'runtime');
    cleanupOldUpdateTempRoots(runtimeRoot);
    const updateTempRoot = getUpdateTempRoot(runtimeRoot);
    ensureContainedDirectory(deployedBundleRoot, updateTempRoot);
    const updateTempBinding = bindContainedDestination(deployedBundleRoot, updateTempRoot);
    assertContainedDestination(updateTempBinding);
    const tempInstallRoot = fs.mkdtempSync(path.join(updateTempRoot, 'npm-'));
    assertContainedDestination(updateTempBinding);
    const tempInstallBinding = bindContainedDestination(deployedBundleRoot, tempInstallRoot);
    ownedUpdateTempRoots.set(tempInstallRoot, tempInstallBinding);
    const cleanupTempInstall = () => {
        removeBoundContainedPath(tempInstallBinding, true);
        ownedUpdateTempRoots.delete(tempInstallRoot);
    };

    let acquiredSource: AcquiredUpdateSource | null = null;
    try {
        const installArgs = [
            'install',
            '--prefix',
            tempInstallRoot,
            '--no-save',
            '--ignore-scripts',
            '--package-lock=false',
            '--fund=false',
            '--audit=false',
            installPackageSpec
        ];
        const installOptions = {
            signal: signal ?? undefined,
            onStderr: onProgress ?? undefined
        };
        const installResult = npmInstallRunner
            ? await npmInstallRunner(installArgs, installOptions)
            : await runNpmStreamed(installArgs, installOptions);

        const failedInstallDiagnostic = buildNpmInstallFailureDiagnostic(
            installResult,
            effectivePackageSpec,
            effectiveDiagnosticSource
        );
        if (failedInstallDiagnostic) {
            throw failedInstallDiagnostic;
        }

        const installed = installedPackageRootResolver
            ? installedPackageRootResolver(tempInstallRoot, { sourceReference: effectiveDiagnosticSource })
            : resolveInstalledPackageRoot(tempInstallRoot, { sourceReference: effectiveDiagnosticSource });
        const provenance = buildReleaseUpdateProvenance({
            sourceType: 'npm',
            sourceReference: installPackageSpec,
            trustPolicy: trustResult.policy,
            trustOverrideUsed: trustResult.overridden,
            requestedPackageSpec: resolvedPackageSpec.requestedSpec,
            exactPackageSpec: resolvedPackageSpec.exactSpec,
            resolvedPackageVersion: resolvedPackageSpec.version,
            resolvedPackageIntegrity: resolvedPackageSpec.integrity
        });
        acquiredSource = {
            sourceType: 'npm',
            sourceReference: installPackageSpec,
            diagnosticSourceReference: effectiveDiagnosticSource,
            packageSpec: installPackageSpec,
            requestedPackageSpec: resolvedPackageSpec.requestedSpec,
            exactPackageSpec: resolvedPackageSpec.exactSpec,
            resolvedPackageVersion: resolvedPackageSpec.version,
            resolvedPackageIntegrity: resolvedPackageSpec.integrity,
            releaseProvenanceStatus: provenance.releaseProvenanceStatus,
            releaseProvenanceSummary: provenance.releaseProvenanceSummary,
            releaseProvenanceRecommendation: provenance.releaseProvenanceRecommendation,
            packageName: installed.packageName,
            sourceRoot: installed.packageRoot,
            trustPolicy: trustResult.policy,
            trustOverrideUsed: trustResult.overridden,
            trustOverrideSource: trustResult.overrideSource || 'none',
            diagnosticTool: diagnosticTool || 'npm',
            cleanup() {
                cleanupTempInstall();
            }
        };
        return acquiredSource;
    } finally {
        if (!acquiredSource) {
            cleanupTempInstall();
        }
    }
}
