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

function fingerprintNpmConfiguration(cwd: string): string {
    const hash = crypto.createHash('sha256');
    const env = Object.entries(process.env).filter(([key]) => /^npm_config_/iu.test(key)
        || ['npm_execpath', 'PATH', 'HOME', 'USERPROFILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].includes(key));
    hash.update(JSON.stringify(env.sort(([a], [b]) => a.localeCompare(b))));
    hash.update(process.execPath);
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
    for (const filePath of [...configPaths].sort()) {
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

export function resolveUpdateAvailabilitySource(repoRoot: string): UpdateAvailabilitySource {
    const cwd = path.resolve(repoRoot);
    const bundleRoot = joinOrchestratorPath(cwd, '');
    const currentVersion = readCurrentBundleVersionOrThrow(bundleRoot);
    if (!isUpdateVersion(currentVersion)) throw new Error('Installed Garda version is invalid.');
    const packagePath = path.join(bundleRoot, 'package.json');
    let packageName = PRIMARY_PACKAGE_NAME;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid installed package metadata.');
        const name = (parsed as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) packageName = name.trim();
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const packageSpec = `${packageName}@latest`;
    validateNpmSourceTrust(packageSpec, { trustOverride: false });
    const configurationSha256 = fingerprintNpmConfiguration(cwd);
    const fingerprint = crypto.createHash('sha256')
        .update(JSON.stringify({ packageSpec, configurationSha256, trustPolicy: 'enforced' })).digest('hex');
    return { bundleRoot, cwd, currentVersion, packageSpec, fingerprint, trustPolicy: 'enforced',
        transport: { kind: 'npm-cli', configurationSha256 } };
}
