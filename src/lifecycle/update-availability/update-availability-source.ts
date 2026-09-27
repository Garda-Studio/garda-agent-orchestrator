import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRIMARY_PACKAGE_NAME } from '../../core/constants';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { readCurrentBundleVersionOrThrow } from '../check-update/check-update-bundle-sync';
import { validateNpmSourceTrust } from '../update/update-trust';
import { type UpdateAvailabilitySource, type UpdateMetadata } from './update-availability-types';

export function isUpdateVersion(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 128
        && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

export function isUpdateMetadata(value: unknown): value is UpdateMetadata {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return isUpdateVersion(record.version) && typeof record.integrity === 'string'
        && record.integrity.length > 0 && record.integrity.length <= 1024;
}

function transportEnvironment(): (readonly [string, string | undefined])[] {
    const transportKeys = new Set(['npm_execpath', 'path', 'home', 'userprofile', 'node_extra_ca_certs', 'https_proxy', 'http_proxy', 'no_proxy']);
    return Object.entries(process.env).filter(([key]) => /^npm_config_/iu.test(key) || transportKeys.has(key.toLowerCase()))
        .map(([key, value]) => [process.platform === 'win32' ? key.toLowerCase() : key, value] as const)
        .sort(([a], [b]) => a.localeCompare(b));
}

/** No filesystem access: compare the caller environment with its child launch snapshot. */
export function updateAvailabilityEnvironmentFingerprint(): string {
    return crypto.createHash('sha256').update(JSON.stringify(transportEnvironment())).update(process.execPath).digest('hex');
}

function configurationInputs(cwd: string): { hash: crypto.Hash; configPaths: string[] } {
    const env = transportEnvironment();
    const hash = crypto.createHash('sha256').update(JSON.stringify(env)).update(process.execPath);
    const configPaths = new Set<string>([
        path.join(os.homedir(), '.npmrc'),
        path.join(path.dirname(process.execPath), 'etc', 'npmrc'),
        path.resolve(path.dirname(process.execPath), '..', 'etc', 'npmrc')
    ]);
    for (const [key, value] of env) {
        if (/^npm_config_(userconfig|globalconfig)$/iu.test(key) && value) configPaths.add(path.resolve(cwd, value));
        if (/^npm_config_prefix$/iu.test(key) && value) configPaths.add(path.resolve(cwd, value, 'etc', 'npmrc'));
    }
    let directory = cwd;
    while (true) {
        configPaths.add(path.join(directory, '.npmrc'));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return { hash, configPaths: [...configPaths].sort() };
}

function fingerprintNpmConfiguration(cwd: string): string {
    const { hash, configPaths } = configurationInputs(cwd);
    for (const filePath of configPaths) {
        hash.update(filePath);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Unsupported npm configuration file.');
            hash.update(fs.readFileSync(filePath));
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            hash.update('<absent>');
        }
    }
    return hash.digest('hex');
}

async function fingerprintNpmConfigurationAsync(cwd: string): Promise<string> {
    const { hash, configPaths } = configurationInputs(cwd);
    const contents = await Promise.all(configPaths.map(async filePath => {
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Unsupported npm configuration file.');
            return await fs.promises.readFile(filePath);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return '<absent>';
        }
    }));
    configPaths.forEach((filePath, index) => { hash.update(filePath); hash.update(contents[index]); });
    return hash.digest('hex');
}

function sourceFor(cwd: string, bundleRoot: string, currentVersion: string, packageText: string | null, configurationSha256: string): UpdateAvailabilitySource {
    if (!isUpdateVersion(currentVersion)) throw new Error('Installed Garda version is invalid.');
    let packageName = PRIMARY_PACKAGE_NAME;
    if (packageText !== null) {
        const parsed: unknown = JSON.parse(packageText);
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid installed package metadata.');
        const name = (parsed as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) packageName = name.trim();
    }
    const packageSpec = `${packageName}@latest`;
    validateNpmSourceTrust(packageSpec, { trustOverride: false });
    const fingerprint = crypto.createHash('sha256')
        .update(JSON.stringify({ packageSpec, configurationSha256, trustPolicy: 'enforced' })).digest('hex');
    return { bundleRoot, cwd, currentVersion, packageSpec, fingerprint, trustPolicy: 'enforced',
        transport: { kind: 'npm-cli', configurationSha256 } };
}

export function resolveUpdateAvailabilitySource(repoRoot: string): UpdateAvailabilitySource {
    const cwd = path.resolve(repoRoot);
    const bundleRoot = joinOrchestratorPath(cwd, '');
    const currentVersion = readCurrentBundleVersionOrThrow(bundleRoot);
    const packagePath = path.join(bundleRoot, 'package.json');
    let packageText: string | null = null;
    try {
        packageText = fs.readFileSync(packagePath, 'utf8');
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return sourceFor(cwd, bundleRoot, currentVersion, packageText, fingerprintNpmConfiguration(cwd));
}

export async function resolveUpdateAvailabilitySourceAsync(repoRoot: string): Promise<UpdateAvailabilitySource> {
    const cwd = path.resolve(repoRoot);
    const bundleRoot = joinOrchestratorPath(cwd, '');
    const [version, packageText, configuration] = await Promise.all([
        fs.promises.readFile(path.join(bundleRoot, 'VERSION'), 'utf8'),
        fs.promises.readFile(path.join(bundleRoot, 'package.json'), 'utf8').catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return null;
        }),
        fingerprintNpmConfigurationAsync(cwd)
    ]);
    return sourceFor(cwd, bundleRoot, version.trim(), packageText, configuration);
}
