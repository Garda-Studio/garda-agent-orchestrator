export const PACKAGE_SURFACE_SCHEMA_VERSION = 2 as const;

export const PACKAGE_SURFACE_BASELINE_PATH = 'config/release-package-surface-baseline.json';
export const PACKAGE_SURFACE_ARTIFACT_PATH = 'garda-agent-orchestrator/runtime/release/package-surface-current.json';

export const PACKAGE_SURFACE_RISK_SIGNALS = Object.freeze([
    'child_process',
    'exec',
    'fetch',
    'fs',
    'readFile',
    'writeFile'
] as const);

export type PackageSurfaceRiskSignal = typeof PACKAGE_SURFACE_RISK_SIGNALS[number];
export type PackageSurfaceRiskSignals = Record<PackageSurfaceRiskSignal, number>;

export const PACKAGE_SURFACE_LIFECYCLE_SCRIPTS = Object.freeze([
    'install',
    'postinstall',
    'postpack',
    'postprepare',
    'postpublish',
    'preinstall',
    'prepack',
    'preprepare',
    'prepare',
    'prepublish',
    'prepublishOnly',
    'publish'
] as const);

export interface NpmPackFile {
    path: string;
    size: number;
}

export interface NpmPackReport {
    name: string;
    version: string;
    filename: string;
    entryCount: number;
    unpackedSize: number;
    files: NpmPackFile[];
}

export interface PackageSurfaceMetrics {
    fileCount: number;
    unpackedSizeBytes: number;
    installedSizeBytes: number;
    productionDependencyCount: number;
    lifecycleScripts: Record<string, string>;
    unexpectedExecutablePaths: string[];
    minifiedArtifactPaths: string[];
    urlHosts: string[];
    metadata: {
        description: string;
        author: string;
        license: string;
        type: string;
        repository: string;
        homepage: string;
        bugs: string;
        funding: string;
        bin: Record<string, string>;
        engines: Record<string, string>;
    };
    riskSignals: PackageSurfaceRiskSignals;
}

export interface PackageSurfaceArtifact {
    schemaVersion: typeof PACKAGE_SURFACE_SCHEMA_VERSION;
    package: {
        name: string;
        version: string;
    };
    packedFileManifestSha256: string;
    tarballSha256: string;
    packedFileSha256: Record<string, string>;
    metrics: PackageSurfaceMetrics;
}

export interface PackageSurfaceAllowedGrowth {
    fileCount: number;
    unpackedSizeBytes: number;
    installedSizeBytes: number;
    riskSignals: PackageSurfaceRiskSignals;
}

export interface PackageSurfaceBaseline {
    schemaVersion: typeof PACKAGE_SURFACE_SCHEMA_VERSION;
    package: {
        name: string;
        version: string;
    };
    packedFileManifestSha256: string;
    tarballSha256: string;
    tarballSha256ByPlatform?: Partial<Record<NodeJS.Platform, string>>;
    packedFileSha256: Record<string, string>;
    metrics: PackageSurfaceMetrics;
    allowedGrowth: PackageSurfaceAllowedGrowth;
    rationale: string;
}

export type PackageSurfaceReference = PackageSurfaceBaseline | PackageSurfaceArtifact;

export interface PackageSurfaceComparisonResult {
    passed: boolean;
    current: PackageSurfaceArtifact;
    reference: PackageSurfaceReference;
    referenceKind: 'baseline' | 'prior-artifact';
    referencePath: string;
    platform: NodeJS.Platform;
    referenceTarballSha256: string | null;
    allowedGrowth: PackageSurfaceAllowedGrowth;
    violations: string[];
}

export interface PackageSurfaceCliOptions {
    baselinePath: string | null;
    outputPath: string | null;
    priorArtifactPath: string | null;
    confirmBaselineUpdate: boolean;
    rationale: string | null;
}

export interface PackageSurfaceBaselineOptions {
    rationale: string;
    allowedGrowth: PackageSurfaceAllowedGrowth;
}

export interface PackageSurfaceBaselineUpdateOptions extends PackageSurfaceBaselineOptions {
    confirmed: boolean;
}
