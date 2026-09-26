export const CLEAN_WORKTREE_DIRTY_PATH_LIMIT = 40;

export const SECURITY_RELEASE_DOC_ITEMS = Object.freeze([
    'SECURITY.md',
    'docs/threat-model.md',
    'docs/sbom.md'
]);

export const PUBLIC_PACKAGE_DOC_ITEMS = Object.freeze([
    'README.md',
    'HOW_TO.md',
    'CHANGELOG.md',
    'docs/assets/garda-github-social-preview.png',
    'docs/architecture.md',
    'docs/branch-protection.md',
    'docs/cli-reference.md',
    'docs/compatibility-matrix.md',
    'docs/configuration.md',
    'docs/control-plane-isolation.md',
    'docs/database/sqlite-persistence.md',
    'docs/database/sqlite-query-adoption-evidence.md',
    'docs/findings-contracts.md',
    'docs/node-platform-foundation.md',
    'docs/node-runtime-contract.md',
    'docs/operator-consistency-runbook.md',
    'docs/orchestrator-work-and-isolation.md',
    'docs/providers.md',
    'docs/release-readiness.md',
    'docs/secret-scanning.md',
    'docs/work-example.md'
]);

export const RELEASE_READINESS_CHECKLIST_PATH = 'docs/release-readiness.md';

export const PUBLISHED_PACKAGE_SURFACE_ITEMS = Object.freeze([
    'bin',
    'dist',
    'template',
    'package.json',
    'MANIFEST.md',
    'docs/operator-consistency-runbook.md',
    'VERSION'
]);

export const FORBIDDEN_PUBLISHED_PACKAGE_SURFACE_ITEMS = Object.freeze([
    '.node-build',
    '.scripts-build',
    'src',
    'tests'
]);

export const RELEASE_VALIDATION_COMMANDS = Object.freeze([
    'version-parity',
    'clean-worktree',
    'embedded-bundle-parity',
    'release-readiness',
    'package-surface',
    'package-surface-baseline'
] as const);

export type ReleaseValidationCommand = typeof RELEASE_VALIDATION_COMMANDS[number];

export const EMBEDDED_BUNDLE_PARITY_ITEMS = Object.freeze([
    '.gitattributes',
    'bin',
    'dist',
    'package.json',
    'src',
    'template',
    'README.md',
    'HOW_TO.md',
    'MANIFEST.md',
    'AGENT_INIT_PROMPT.md',
    'CHANGELOG.md',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'docs/assets/garda-github-social-preview.png',
    'docs/architecture.md',
    'docs/branch-protection.md',
    'docs/cli-reference.md',
    'docs/compatibility-matrix.md',
    'docs/configuration.md',
    'docs/node-platform-foundation.md',
    'docs/node-runtime-contract.md',
    'docs/threat-model.md',
    'docs/sbom.md',
    'docs/control-plane-isolation.md',
    'docs/database/sqlite-persistence.md',
    'docs/database/sqlite-query-adoption-evidence.md',
    'docs/orchestrator-work-and-isolation.md',
    'docs/providers.md',
    'docs/secret-scanning.md',
    'TRADEMARKS.md',
    'docs/operator-consistency-runbook.md',
    'docs/work-example.md',
    'VERSION'
]);

export interface ReleaseVersionParityState {
    repoRoot: string;
    versionFileValue: string | null;
    packageJsonVersion: string | null;
    packageLockVersion: string | null;
    packageLockRootPackageVersion: string | null;
    deployedLiveVersion: string | null;
}

export interface ReleaseVersionParityResult extends ReleaseVersionParityState {
    passed: boolean;
    violations: string[];
}

export interface CleanWorktreePreflightState {
    repoRoot: string;
    headSha: string | null;
    branchName: string | null;
    detachedHead: boolean;
    dirtyPaths: string[];
}

export interface CleanWorktreePreflightResult extends CleanWorktreePreflightState {
    passed: boolean;
    violations: string[];
    remediation: string;
}

export interface EmbeddedBundleParityItemResult {
    item: string;
    rootExists: boolean;
    bundleExists: boolean;
    rootHash: string | null;
    bundleHash: string | null;
}

export interface EmbeddedBundleParityOptions {
    required?: boolean;
}

export interface EmbeddedBundleParityResult {
    repoRoot: string;
    bundleRoot: string;
    bundlePresent: boolean;
    bundleIgnoredByGit: boolean;
    checkedItems: string[];
    required: boolean;
    status: 'PASSED' | 'FAILED' | 'SKIPPED';
    skippedReason: string | null;
    passed: boolean;
    violations: string[];
    items: EmbeddedBundleParityItemResult[];
}

export interface ReleaseReadinessCheck {
    area: string;
    label: string;
    passed: boolean;
    details: string[];
}

export interface ReleaseReadinessResult {
    repoRoot: string;
    version: string | null;
    passed: boolean;
    violations: string[];
    checks: ReleaseReadinessCheck[];
    releaseChecklistItems: string[];
    openReleaseChecklistItems: string[];
    releaseNotesInput: string[];
}
