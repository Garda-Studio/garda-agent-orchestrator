import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    assertExistingPathIdentity,
    bindContainedDestination,
    type ContainedDestination
} from '../../../src/core/contained-filesystem';
import { assertCopySourceTree } from '../../../src/lifecycle/generic-utils';

import { getRepoRoot } from '../build';
import {
    EMBEDDED_BUNDLE_PARITY_ITEMS,
    type EmbeddedBundleParityItemResult,
    type EmbeddedBundleParityOptions,
    type EmbeddedBundleParityResult
} from './types';
import { hashSurfaceItem, isGitIgnored } from './shared';

function bindBundleRoots(repoRoot: string, bundleRoot: string): ContainedDestination[] {
    const bindings = [
        bindContainedDestination(path.parse(repoRoot).root, repoRoot),
        bindContainedDestination(repoRoot, bundleRoot)
    ];
    const repoStat = fs.lstatSync(repoRoot, { bigint: true });
    const bundleStat = fs.lstatSync(bundleRoot, { bigint: true });
    if (!repoStat.isDirectory() || !bundleStat.isDirectory()
        || (repoStat.dev === bundleStat.dev && repoStat.ino === bundleStat.ino)) {
        throw new Error('Embedded bundle must be an ordinary directory distinct from the repository root.');
    }
    return bindings;
}

function hashBoundSurfaceItem(binding: ContainedDestination): string | null {
    if (binding.missingAt) return null;
    assertCopySourceTree(binding.path);
    assertExistingPathIdentity(binding);
    const hash = hashSurfaceItem(binding.path);
    assertExistingPathIdentity(binding);
    return hash;
}

export function validateEmbeddedBundleParity(
    repoRoot: string,
    items: readonly string[] = EMBEDDED_BUNDLE_PARITY_ITEMS,
    options: EmbeddedBundleParityOptions = {}
): EmbeddedBundleParityResult {
    const normalizedRoot = path.resolve(repoRoot);
    const bundleRoot = path.join(normalizedRoot, 'garda-agent-orchestrator');
    const bundlePresent = fs.existsSync(bundleRoot);
    let rootBindings: ContainedDestination[] = [];
    let boundaryViolation: string | null = null;
    if (bundlePresent) {
        try {
            rootBindings = bindBundleRoots(normalizedRoot, bundleRoot);
        } catch (error) {
            boundaryViolation = `Invalid embedded bundle boundary: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    const bundleIgnoredByGit = !boundaryViolation && bundlePresent && isGitIgnored(normalizedRoot, 'garda-agent-orchestrator');
    const required = options.required !== false;
    const violations: string[] = [];
    const itemResults: EmbeddedBundleParityItemResult[] = [];
    const checkedItems = [...items];
    const unavailableReason = boundaryViolation ?? (!bundlePresent
        ? 'Embedded bundle is missing; no parity items were inspected.'
        : bundleIgnoredByGit && !required
            ? 'Embedded bundle is gitignored; no parity items were inspected.'
            : checkedItems.length === 0
                ? 'No embedded bundle parity items were selected for inspection.'
                : null);

    if (unavailableReason) {
        return {
            repoRoot: normalizedRoot,
            bundleRoot,
            bundlePresent,
            bundleIgnoredByGit,
            checkedItems,
            required,
            status: required || boundaryViolation ? 'FAILED' : 'SKIPPED',
            skippedReason: required || boundaryViolation ? null : unavailableReason,
            passed: false,
            violations: required || boundaryViolation ? [unavailableReason] : [],
            items: itemResults
        };
    }

    for (const item of checkedItems) {
        const rootItemPath = path.join(normalizedRoot, item);
        const bundleItemPath = path.join(bundleRoot, item);
        try {
            rootBindings.forEach(assertExistingPathIdentity);
            const rootItem = bindContainedDestination(normalizedRoot, rootItemPath);
            const bundleItem = bindContainedDestination(bundleRoot, bundleItemPath);
            const rootExists = !rootItem.missingAt;
            const bundleExists = !bundleItem.missingAt;
            const rootHash = hashBoundSurfaceItem(rootItem);
            const bundleHash = hashBoundSurfaceItem(bundleItem);
            assertExistingPathIdentity(rootItem);
            assertExistingPathIdentity(bundleItem);
            rootBindings.forEach(assertExistingPathIdentity);

            itemResults.push({ item, rootExists, bundleExists, rootHash, bundleHash });
            if (!rootExists || !bundleExists) {
                violations.push(`${item}: missing root=${rootExists} bundle=${bundleExists}`);
            } else if (rootHash !== bundleHash) {
                violations.push(`${item}: hash mismatch`);
            }
        } catch (error) {
            violations.push(`${item}: ${error instanceof Error ? error.message : String(error)}`);
            break;
        }
    }

    return {
        repoRoot: normalizedRoot,
        bundleRoot,
        bundlePresent,
        bundleIgnoredByGit,
        checkedItems,
        required,
        status: violations.length === 0 ? 'PASSED' : 'FAILED',
        skippedReason: null,
        passed: violations.length === 0,
        violations,
        items: itemResults
    };
}

export function formatEmbeddedBundleParityResult(result: EmbeddedBundleParityResult): string {
    const marker = result.status === 'PASSED' ? 'OK' : result.status;
    const lines = [
        `RELEASE_EMBEDDED_BUNDLE_PARITY_${marker}`,
        `RepoRoot: ${result.repoRoot}`,
        `BundleRoot: ${result.bundleRoot}`,
        `Required: ${result.required ? 'yes' : 'no'}`,
        `BundlePresent: ${result.bundlePresent ? 'yes' : 'no'}`,
        `BundleIgnoredByGit: ${result.bundleIgnoredByGit ? 'yes' : 'no'}`,
        `ParityStatus: ${result.status}`,
        `CheckedItems: ${result.items.length}`
    ];
    if (result.skippedReason) {
        lines.push(`SkipReason: ${result.skippedReason}`);
    }
    for (const violation of result.violations) {
        lines.push(`- ${violation}`);
    }
    if (result.status === 'FAILED') {
        lines.push('Remediation: select at least one parity item and refresh the embedded bundle from the root source before release.');
    }
    return lines.join('\n');
}

export function runEmbeddedBundleParityValidation(options: EmbeddedBundleParityOptions = {}): EmbeddedBundleParityResult {
    const result = validateEmbeddedBundleParity(getRepoRoot(), EMBEDDED_BUNDLE_PARITY_ITEMS, options);
    console.log(formatEmbeddedBundleParityResult(result));
    if (result.status === 'FAILED') {
        process.exit(1);
    }
    return result;
}
