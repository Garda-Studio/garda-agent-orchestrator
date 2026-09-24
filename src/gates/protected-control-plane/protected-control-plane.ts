import * as fs from 'node:fs';
import * as path from 'node:path';
import { bindContainedDestination, writeContainedFile } from '../../core/contained-filesystem';
import {
    computeProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath,
    type ProtectedControlPlaneManifest,
    type ProtectedControlPlaneManifestEvidence
} from '../../core/protected-control-plane-contracts';
import {
    ALL_AGENT_ENTRYPOINT_FILES,
    DEFAULT_BUNDLE_NAME,
    isBundleRootLike,
    isRecognizedBundleName,
    isRecognizedPackageName,
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from '../../materialization/common';
import { scanProtectedPathHashesIncremental, type ProtectedHashScanOptions } from './protected-hash-cache';
import { normalizePath } from '../shared/path-utils';

export {
    computeProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath
} from '../../core/protected-control-plane-contracts';
export type {
    ProtectedControlPlaneManifest,
    ProtectedControlPlaneManifestEvidence
} from '../../core/protected-control-plane-contracts';

/**
 * Detect whether repoRoot is the orchestrator source checkout itself.
 */
export function isOrchestratorSourceCheckout(repoRoot: string): boolean {
    const packageJsonPath = path.join(path.resolve(repoRoot), 'package.json');
    if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
        return false;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
        return isRecognizedPackageName(parsed.name);
    } catch {
        return false;
    }
}

/**
 * Return protected control-plane roots for this workspace.
 * Ordinary workspaces protect only the deployed bundle.
 * The orchestrator source checkout additionally protects root-level runtime sources.
 */
export function getProtectedControlPlaneRoots(repoRoot: string): string[] {
    const effectiveName = resolveBundleNameForTarget(repoRoot);
    const protectsRootControlPlane = isOrchestratorSourceCheckout(repoRoot) || isBundleRootLike(repoRoot);
    const bundleNames = [...new Set([effectiveName, DEFAULT_BUNDLE_NAME].filter(Boolean))];
    const bundleRoots = bundleNames.flatMap((bundleName) => [
        `${bundleName}/src/bin/`,
        `${bundleName}/src/cli/`,
        `${bundleName}/src/gates/`,
        `${bundleName}/src/gate-runtime/`,
        `${bundleName}/src/lifecycle/`,
        `${bundleName}/src/materialization/`,
        `${bundleName}/bin/`,
        `${bundleName}/dist/`,
        `${bundleName}/live/config/workflow-config.json`,
        `${bundleName}/live/config/task-reset-enablement-receipt.json`,
        `${bundleName}/template/config/workflow-config.json`,
        `${bundleName}/live/docs/agent-rules/`
    ]);
    const roots = [
        ...bundleRoots,
        'live/config/task-reset-enablement-receipt.json',
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        ...ALL_AGENT_ENTRYPOINT_FILES,
        ...getProviderOrchestratorProfileDefinitions().map((profile) => profile.orchestratorRelativePath),
        ...getGitHubSkillBridgeProfileDefinitions().map((profile) => profile.relativePath)
    ];

    if (protectsRootControlPlane) {
        roots.push(
            'src/bin/',
            'src/cli/',
            'src/gates/',
            'src/gate-runtime/',
            'src/lifecycle/',
            'src/materialization/',
            'bin/',
            'dist/',
            'live/config/workflow-config.json',
            'live/config/task-reset-enablement-receipt.json',
            'template/config/workflow-config.json',
            'live/docs/agent-rules/'
        );
    }

    return normalizeProtectedControlPlaneRoots(roots);
}

export function isWorkflowConfigControlPlanePathShape(relativePath: string): boolean {
    const normalized = normalizePath(relativePath).replace(/^\.\//, '');
    if (
        normalized === 'live/config/workflow-config.json'
        || normalized === 'template/config/workflow-config.json'
    ) {
        return true;
    }
    const parts = normalized.split('/');
    return parts.length === 4
        && (
            (
                parts[1] === 'live'
                && parts[2] === 'config'
                && parts[3] === 'workflow-config.json'
            )
            || (
                parts[1] === 'template'
                && parts[2] === 'config'
                && parts[3] === 'workflow-config.json'
            )
        );
}

export function isWorkflowConfigControlPlanePath(relativePath: string): boolean {
    const normalized = normalizePath(relativePath).replace(/^\.\//, '');
    if (
        normalized === 'live/config/workflow-config.json'
        || normalized === 'template/config/workflow-config.json'
    ) {
        return true;
    }
    const parts = normalized.split('/');
    return parts.length === 4
        && isRecognizedBundleName(parts[0])
        && isWorkflowConfigControlPlanePathShape(normalized);
}

/**
 * Scan protected roots recursively and return a map of path -> sha256 hash.
 * Delegates to the incremental implementation that uses a persisted metadata
 * cache (mtime + size) to skip unchanged files while preserving identical
 * drift-detection semantics.
 */
export function scanProtectedPathHashes(
    repoRoot: string,
    protectedRoots: string[],
    readOnlyOrOptions: boolean | ProtectedHashScanOptions = false
): Record<string, string> {
    return scanProtectedPathHashesIncremental(repoRoot, protectedRoots, readOnlyOrOptions);
}

/**
 * Build the current trusted protected control-plane manifest from the workspace.
 */
export function buildProtectedControlPlaneManifest(repoRoot: string): ProtectedControlPlaneManifest {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const protectedRoots = getProtectedControlPlaneRoots(normalizedRepoRoot);
    const manifestPath = resolveProtectedControlPlaneManifestPath(normalizedRepoRoot);
    const protectedSnapshot = scanProtectedPathHashes(normalizedRepoRoot, protectedRoots);
    return {
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: new Date().toISOString(),
        workspace_root: normalizePath(normalizedRepoRoot),
        orchestrator_root: normalizePath(path.dirname(path.dirname(manifestPath))),
        protected_roots: protectedRoots,
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: isOrchestratorSourceCheckout(normalizedRepoRoot)
    };
}

/**
 * Persist the trusted protected control-plane manifest after a lifecycle action.
 */
export function writeProtectedControlPlaneManifest(repoRoot: string): string {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    bindContainedDestination(repoRoot, manifestPath);
    const manifest = buildProtectedControlPlaneManifest(repoRoot);
    writeContainedFile(repoRoot, manifestPath, JSON.stringify(manifest, null, 2));
    return manifestPath;
}

/**
 * Compare the current protected snapshot with the last trusted lifecycle manifest.
 */
export function evaluateProtectedControlPlaneManifest(
    repoRoot: string,
    currentSnapshot?: Record<string, string> | null,
    readOnlyOrOptions: boolean | ProtectedHashScanOptions = false
): ProtectedControlPlaneManifestEvidence {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const normalizedManifestPath = normalizePath(manifestPath);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        return {
            status: 'MISSING',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: null
        };
    }

    let manifestObject: ProtectedControlPlaneManifest;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        if (
            !parsed
            || typeof parsed !== 'object'
            || Array.isArray(parsed)
            || !parsed.protected_snapshot
            || typeof parsed.protected_snapshot !== 'object'
            || Array.isArray(parsed.protected_snapshot)
        ) {
            return {
                status: 'INVALID',
                manifest_path: normalizedManifestPath,
                changed_files: [],
                manifest: null
            };
        }
        manifestObject = parsed as unknown as ProtectedControlPlaneManifest;
    } catch {
        return {
            status: 'INVALID',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: null
        };
    }

    const snapshot = currentSnapshot || scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), readOnlyOrOptions);
    const snapshotDigest = computeProtectedSnapshotDigest(snapshot);
    const manifestSnapshot = manifestObject.protected_snapshot || {};
    const manifestDigest = typeof manifestObject.protected_snapshot_sha256 === 'string'
        ? String(manifestObject.protected_snapshot_sha256).trim().toLowerCase()
        : '';
    if (manifestDigest && snapshotDigest === manifestDigest) {
        return {
            status: 'MATCH',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: manifestObject
        };
    }
    const manifestRoots = normalizeProtectedControlPlaneRoots(manifestObject.protected_roots || []);
    const pathBelongsToManifestRoots = (protectedPath: string): boolean => {
        if (manifestRoots.length === 0) {
            return true;
        }
        const normalizedPath = normalizePath(protectedPath);
        return manifestRoots.some((root) => (
            root.endsWith('/')
                ? normalizedPath.startsWith(root)
                : normalizedPath === root
        ));
    };

    const changedFiles: string[] = [];
    const allProtectedPaths = new Set([
        ...Object.keys(manifestSnapshot),
        ...Object.keys(snapshot).filter(pathBelongsToManifestRoots)
    ]);
    for (const protectedPath of allProtectedPaths) {
        if (manifestSnapshot[protectedPath] !== snapshot[protectedPath]) {
            changedFiles.push(protectedPath);
        }
    }

    return {
        status: changedFiles.length > 0 ? 'DRIFT' : 'MATCH',
        manifest_path: normalizedManifestPath,
        changed_files: changedFiles.sort(),
        manifest: manifestObject
    };
}

/**
 * Normalize protected control-plane roots.
 * Directory roots should end with `/`; file targets should not.
 */
export function normalizeProtectedControlPlaneRoots(roots: unknown[] | null | undefined): string[] {
    const set = new Set<string>();
    for (const root of (roots || [])) {
        const original = String(root == null ? '' : root).replace(/\\/g, '/');
        const isDirectoryLike = /\/$/.test(original);
        let value = normalizePath(root);
        if (!value) continue;
        value = value.replace(/\/+$/, '');
        if (!value) continue;
        if (isDirectoryLike) value += '/';
        set.add(value);
    }
    return [...set].sort();
}
