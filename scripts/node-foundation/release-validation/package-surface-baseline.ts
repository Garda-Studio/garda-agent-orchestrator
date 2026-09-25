import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    PACKAGE_SURFACE_LIFECYCLE_SCRIPTS,
    PACKAGE_SURFACE_RISK_SIGNALS,
    PACKAGE_SURFACE_SCHEMA_VERSION,
    type PackageSurfaceAllowedGrowth,
    type PackageSurfaceArtifact,
    type PackageSurfaceBaseline,
    type PackageSurfaceBaselineOptions,
    type PackageSurfaceBaselineUpdateOptions,
    type PackageSurfaceComparisonResult,
    type PackageSurfaceMetrics,
    type PackageSurfaceReference,
    type PackageSurfaceRiskSignals
} from './package-surface-types';

export const DEFAULT_PACKAGE_SURFACE_ALLOWED_GROWTH: PackageSurfaceAllowedGrowth = Object.freeze({
    fileCount: 10,
    unpackedSizeBytes: 256 * 1024,
    installedSizeBytes: 256 * 1024,
    riskSignals: Object.freeze({
        child_process: 0,
        exec: 0,
        fetch: 0,
        fs: 0,
        readFile: 0,
        writeFile: 0
    })
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

function cloneAllowedGrowth(value: PackageSurfaceAllowedGrowth): PackageSurfaceAllowedGrowth {
    return {
        fileCount: value.fileCount,
        unpackedSizeBytes: value.unpackedSizeBytes,
        installedSizeBytes: value.installedSizeBytes,
        riskSignals: { ...value.riskSignals }
    };
}

function assertAllowedGrowth(value: PackageSurfaceAllowedGrowth): void {
    const entries: Array<readonly [string, number]> = [
        ['fileCount', value.fileCount],
        ['unpackedSizeBytes', value.unpackedSizeBytes],
        ['installedSizeBytes', value.installedSizeBytes],
        ...PACKAGE_SURFACE_RISK_SIGNALS.map(
            (signal): readonly [string, number] => [`riskSignals.${signal}`, value.riskSignals[signal]]
        )
    ];
    for (const [label, amount] of entries) {
        if (!Number.isSafeInteger(amount) || amount < 0) {
            throw new Error(`Package-surface allowedGrowth.${label} must be a non-negative safe integer.`);
        }
    }
}

export function createPackageSurfaceBaseline(
    artifact: PackageSurfaceArtifact,
    options: PackageSurfaceBaselineOptions
): PackageSurfaceBaseline {
    const rationale = String(options.rationale || '').trim();
    if (!rationale) {
        throw new Error('Package-surface baseline requires a non-empty --rationale audit note.');
    }
    assertAllowedGrowth(options.allowedGrowth);
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: { ...artifact.package },
        packedFileManifestSha256: artifact.packedFileManifestSha256,
        tarballSha256: artifact.tarballSha256,
        packedFileSha256: { ...artifact.packedFileSha256 },
        metrics: structuredClone(artifact.metrics),
        allowedGrowth: cloneAllowedGrowth(options.allowedGrowth),
        rationale
    };
}

function isBaseline(reference: PackageSurfaceReference): reference is PackageSurfaceBaseline {
    return 'allowedGrowth' in reference;
}

function pushGrowthViolation(
    violations: string[],
    label: string,
    current: number,
    reference: number,
    allowed: number
): void {
    const growth = current - reference;
    if (growth > allowed) {
        violations.push(`${label} current=${current} reference=${reference} growth=${growth} allowed=${allowed}`);
    }
}

function compareLifecycleScripts(current: Record<string, string>, reference: Record<string, string>): string[] {
    const changes: string[] = [];
    const names = [...new Set([...Object.keys(current), ...Object.keys(reference)])].sort();
    for (const name of names) {
        if (!Object.hasOwn(reference, name)) {
            changes.push(`added ${name}=${current[name]}`);
        } else if (!Object.hasOwn(current, name)) {
            changes.push(`removed ${name}=${reference[name]}`);
        } else if (current[name] !== reference[name]) {
            changes.push(`changed ${name}: ${reference[name]} -> ${current[name]}`);
        }
    }
    return changes;
}

export function comparePackageSurface(
    current: PackageSurfaceArtifact,
    reference: PackageSurfaceReference,
    referencePath: string
): PackageSurfaceComparisonResult {
    const referenceKind = isBaseline(reference) ? 'baseline' : 'prior-artifact';
    const allowedGrowth = isBaseline(reference)
        ? cloneAllowedGrowth(reference.allowedGrowth)
        : cloneAllowedGrowth(DEFAULT_PACKAGE_SURFACE_ALLOWED_GROWTH);
    const violations: string[] = [];
    if (current.package.name !== reference.package.name) {
        violations.push(`package name current=${current.package.name} reference=${reference.package.name}`);
    }
    const changedFiles = Object.keys(reference.packedFileSha256).filter((file) =>
        Object.hasOwn(current.packedFileSha256, file)
        && current.packedFileSha256[file] !== reference.packedFileSha256[file]
    ).sort(compareText);
    if (changedFiles.length > 0) {
        violations.push(`packed file SHA-256 changed (${changedFiles.length}): ${changedFiles.slice(0, 20).join(', ')}`);
    }
    const removedFiles = Object.keys(reference.packedFileSha256).filter((file) =>
        !Object.hasOwn(current.packedFileSha256, file)
    ).sort(compareText);
    if (removedFiles.length > 0) {
        violations.push(`packed files removed (${removedFiles.length}): ${removedFiles.slice(0, 20).join(', ')}`);
    }
    const identicalFileHashes = changedFiles.length === 0 && removedFiles.length === 0
        && Object.keys(current.packedFileSha256).length === Object.keys(reference.packedFileSha256).length;
    if (identicalFileHashes && current.packedFileManifestSha256 !== reference.packedFileManifestSha256) {
        violations.push('packed file manifest SHA-256 changed despite identical file hashes.');
    }
    if (identicalFileHashes && current.tarballSha256 !== reference.tarballSha256) {
        violations.push(`tarball SHA-256 changed despite identical packed files: current=${current.tarballSha256} reference=${reference.tarballSha256}`);
    }
    pushGrowthViolation(
        violations,
        'fileCount',
        current.metrics.fileCount,
        reference.metrics.fileCount,
        allowedGrowth.fileCount
    );
    pushGrowthViolation(
        violations,
        'unpackedSizeBytes',
        current.metrics.unpackedSizeBytes,
        reference.metrics.unpackedSizeBytes,
        allowedGrowth.unpackedSizeBytes
    );
    pushGrowthViolation(
        violations,
        'installedSizeBytes',
        current.metrics.installedSizeBytes,
        reference.metrics.installedSizeBytes,
        allowedGrowth.installedSizeBytes
    );
    if (current.metrics.productionDependencyCount !== reference.metrics.productionDependencyCount) {
        violations.push(`productionDependencyCount current=${current.metrics.productionDependencyCount} reference=${reference.metrics.productionDependencyCount}`);
    }
    if (JSON.stringify(current.metrics.metadata) !== JSON.stringify(reference.metrics.metadata)) {
        violations.push(`required package metadata changed: current=${JSON.stringify(current.metrics.metadata)} reference=${JSON.stringify(reference.metrics.metadata)}`);
    }
    for (const [label, currentPaths, referencePaths] of [
        ['unexpectedExecutablePaths', current.metrics.unexpectedExecutablePaths, reference.metrics.unexpectedExecutablePaths],
        ['minifiedArtifactPaths', current.metrics.minifiedArtifactPaths, reference.metrics.minifiedArtifactPaths],
        ['urlHosts', current.metrics.urlHosts, reference.metrics.urlHosts]
    ] as const) {
        const added = currentPaths.filter((item) => !referencePaths.includes(item));
        if (added.length > 0) {
            violations.push(`${label} added: ${added.join(', ')}`);
        }
    }
    const lifecycleChanges = compareLifecycleScripts(
        current.metrics.lifecycleScripts,
        reference.metrics.lifecycleScripts
    );
    if (lifecycleChanges.length > 0) {
        violations.push(`lifecycleScripts changed: ${lifecycleChanges.join('; ')}`);
    }
    for (const signal of PACKAGE_SURFACE_RISK_SIGNALS) {
        pushGrowthViolation(
            violations,
            `riskSignals.${signal}`,
            current.metrics.riskSignals[signal],
            reference.metrics.riskSignals[signal],
            allowedGrowth.riskSignals[signal]
        );
    }
    return {
        passed: violations.length === 0,
        current,
        reference,
        referenceKind,
        referencePath,
        allowedGrowth,
        violations
    };
}

export function formatPackageSurfaceComparison(result: PackageSurfaceComparisonResult): string {
    const lines = [
        result.passed ? 'PACKAGE_SURFACE_OK' : 'PACKAGE_SURFACE_FAILED',
        `Package: ${result.current.package.name}@${result.current.package.version}`,
        `Reference: ${result.referenceKind} ${result.referencePath}`,
        `FileCount: ${result.current.metrics.fileCount}`,
        `UnpackedSizeBytes: ${result.current.metrics.unpackedSizeBytes}`,
        `InstalledSizeBytes: ${result.current.metrics.installedSizeBytes}`,
        `ProductionDependencies: ${result.current.metrics.productionDependencyCount}`,
        `LifecycleScripts: ${JSON.stringify(result.current.metrics.lifecycleScripts)}`,
        `UnexpectedExecutables: ${JSON.stringify(result.current.metrics.unexpectedExecutablePaths)}`,
        `MinifiedArtifacts: ${JSON.stringify(result.current.metrics.minifiedArtifactPaths)}`,
        `KnownUrlHosts: ${JSON.stringify(result.current.metrics.urlHosts)}`,
        `RequiredMetadata: ${JSON.stringify(result.current.metrics.metadata)}`,
        `TarballSha256: ${result.current.tarballSha256}`,
        `PackedFileManifestSha256: ${result.current.packedFileManifestSha256}`,
        `RiskSignals: ${JSON.stringify(result.current.metrics.riskSignals)}`
    ];
    for (const violation of result.violations) {
        lines.push(`- ${violation}`);
    }
    if (!result.passed) {
        lines.push(
            'Remediation: review the packed diff; for intentional growth run validate-release.js '
            + 'package-surface-baseline --confirm-baseline-update --rationale "<audited reason>" and commit the baseline diff.'
        );
    }
    return lines.join('\n');
}

export function updatePackageSurfaceBaseline(
    baselinePath: string,
    artifact: PackageSurfaceArtifact,
    options: PackageSurfaceBaselineUpdateOptions
): PackageSurfaceBaseline {
    if (!options.confirmed) {
        throw new Error('Refusing baseline update without --confirm-baseline-update.');
    }
    const baseline = createPackageSurfaceBaseline(artifact, options);
    const resolvedPath = path.resolve(baselinePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return baseline;
}

function parseRiskSignals(value: unknown, label: string): PackageSurfaceRiskSignals {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const signals = emptyRiskSignals();
    for (const signal of PACKAGE_SURFACE_RISK_SIGNALS) {
        signals[signal] = requireNonNegativeInteger(value, signal, label);
    }
    return signals;
}

function parseLifecycleScripts(value: unknown, label: string): Record<string, string> {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const scripts: Record<string, string> = {};
    for (const [name, command] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
        if (!PACKAGE_SURFACE_LIFECYCLE_SCRIPTS.includes(name as typeof PACKAGE_SURFACE_LIFECYCLE_SCRIPTS[number])) {
            throw new Error(`${label} contains unsupported lifecycle script: ${name}`);
        }
        if (typeof command !== 'string' || !command.trim()) {
            throw new Error(`${label}.${name} must be a non-empty string.`);
        }
        scripts[name] = command;
    }
    return scripts;
}

function parseMetrics(value: unknown, label: string): PackageSurfaceMetrics {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return {
        fileCount: requireNonNegativeInteger(value, 'fileCount', label),
        unpackedSizeBytes: requireNonNegativeInteger(value, 'unpackedSizeBytes', label),
        installedSizeBytes: requireNonNegativeInteger(value, 'installedSizeBytes', label),
        productionDependencyCount: requireNonNegativeInteger(value, 'productionDependencyCount', label),
        lifecycleScripts: parseLifecycleScripts(value.lifecycleScripts, `${label}.lifecycleScripts`),
        unexpectedExecutablePaths: parseStringList(value.unexpectedExecutablePaths, `${label}.unexpectedExecutablePaths`),
        minifiedArtifactPaths: parseStringList(value.minifiedArtifactPaths, `${label}.minifiedArtifactPaths`),
        urlHosts: parseStringList(value.urlHosts, `${label}.urlHosts`),
        metadata: parseMetadata(value.metadata, `${label}.metadata`),
        riskSignals: parseRiskSignals(value.riskSignals, `${label}.riskSignals`)
    };
}

function parseStringList(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error(`${label} must be an array of non-empty strings.`);
    }
    const items = value as string[];
    if (new Set(items).size !== items.length) {
        throw new Error(`${label} contains duplicate entries.`);
    }
    return [...items];
}

function parseStringMap(value: unknown, label: string): Record<string, string> {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string' || !item.trim()) {
            throw new Error(`${label}.${key} must be a non-empty string.`);
        }
    }
    return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}

function parseSha256(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest.`);
    }
    return value;
}

function parsePackedFileSha256(value: unknown, label: string): Record<string, string> {
    const hashes = parseStringMap(value, label);
    for (const [file, digest] of Object.entries(hashes)) {
        parseSha256(digest, `${label}.${file}`);
    }
    return hashes;
}

function parseMetadata(value: unknown, label: string): PackageSurfaceMetrics['metadata'] {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return {
        description: requireString(value, 'description', label),
        author: requireString(value, 'author', label),
        license: requireString(value, 'license', label),
        type: requireString(value, 'type', label),
        repository: requireString(value, 'repository', label),
        homepage: requireString(value, 'homepage', label),
        bugs: requireString(value, 'bugs', label),
        funding: requireString(value, 'funding', label),
        bin: parseStringMap(value.bin, `${label}.bin`),
        engines: parseStringMap(value.engines, `${label}.engines`)
    };
}

function parsePackageIdentity(value: unknown, label: string): { name: string; version: string } {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return {
        name: requireString(value, 'name', label),
        version: requireString(value, 'version', label)
    };
}

function assertSchemaVersion(value: Record<string, unknown>, label: string): void {
    if (value.schemaVersion !== PACKAGE_SURFACE_SCHEMA_VERSION) {
        throw new Error(`${label}.schemaVersion must be ${PACKAGE_SURFACE_SCHEMA_VERSION}.`);
    }
}

export function parsePackageSurfaceArtifact(value: unknown, label = 'package-surface artifact'): PackageSurfaceArtifact {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    assertSchemaVersion(value, label);
    const manifestHash = parseSha256(value.packedFileManifestSha256, `${label}.packedFileManifestSha256`);
    const tarballHash = parseSha256(value.tarballSha256, `${label}.tarballSha256`);
    const packedFileSha256 = parsePackedFileSha256(value.packedFileSha256, `${label}.packedFileSha256`);
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: parsePackageIdentity(value.package, `${label}.package`),
        packedFileManifestSha256: manifestHash,
        tarballSha256: tarballHash,
        packedFileSha256,
        metrics: parseMetrics(value.metrics, `${label}.metrics`)
    };
}

export function parsePackageSurfaceBaseline(value: unknown, label = 'package-surface baseline'): PackageSurfaceBaseline {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    assertSchemaVersion(value, label);
    if (!isRecord(value.allowedGrowth)) {
        throw new Error(`${label}.allowedGrowth must be an object.`);
    }
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: parsePackageIdentity(value.package, `${label}.package`),
        packedFileManifestSha256: parseSha256(value.packedFileManifestSha256, `${label}.packedFileManifestSha256`),
        tarballSha256: parseSha256(value.tarballSha256, `${label}.tarballSha256`),
        packedFileSha256: parsePackedFileSha256(value.packedFileSha256, `${label}.packedFileSha256`),
        metrics: parseMetrics(value.metrics, `${label}.metrics`),
        allowedGrowth: {
            fileCount: requireNonNegativeInteger(value.allowedGrowth, 'fileCount', `${label}.allowedGrowth`),
            unpackedSizeBytes: requireNonNegativeInteger(
                value.allowedGrowth,
                'unpackedSizeBytes',
                `${label}.allowedGrowth`
            ),
            installedSizeBytes: requireNonNegativeInteger(
                value.allowedGrowth, 'installedSizeBytes', `${label}.allowedGrowth`
            ),
            riskSignals: parseRiskSignals(
                value.allowedGrowth.riskSignals,
                `${label}.allowedGrowth.riskSignals`
            )
        },
        rationale: requireString(value, 'rationale', label).trim()
    };
}
