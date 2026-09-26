import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../build';
import {
    EMBEDDED_BUNDLE_PARITY_ITEMS,
    type EmbeddedBundleParityItemResult,
    type EmbeddedBundleParityOptions,
    type EmbeddedBundleParityResult
} from './types';
import { hashSurfaceItem, isGitIgnored } from './shared';

export function validateEmbeddedBundleParity(
    repoRoot: string,
    items: readonly string[] = EMBEDDED_BUNDLE_PARITY_ITEMS,
    options: EmbeddedBundleParityOptions = {}
): EmbeddedBundleParityResult {
    const normalizedRoot = path.resolve(repoRoot);
    const bundleRoot = path.join(normalizedRoot, 'garda-agent-orchestrator');
    const bundlePresent = fs.existsSync(bundleRoot);
    const bundleIgnoredByGit = bundlePresent && isGitIgnored(normalizedRoot, 'garda-agent-orchestrator');
    const required = options.required !== false;
    const violations: string[] = [];
    const itemResults: EmbeddedBundleParityItemResult[] = [];
    const checkedItems = [...items];
    const unavailableReason = !bundlePresent
        ? 'Embedded bundle is missing; no parity items were inspected.'
        : bundleIgnoredByGit
            ? 'Embedded bundle is gitignored; no parity items were inspected.'
            : checkedItems.length === 0
                ? 'No embedded bundle parity items were selected for inspection.'
                : null;

    if (unavailableReason) {
        return {
            repoRoot: normalizedRoot,
            bundleRoot,
            bundlePresent,
            bundleIgnoredByGit,
            checkedItems,
            required,
            status: required ? 'FAILED' : 'SKIPPED',
            skippedReason: required ? null : unavailableReason,
            passed: false,
            violations: required ? [unavailableReason] : [],
            items: itemResults
        };
    }

    for (const item of checkedItems) {
        const rootItemPath = path.join(normalizedRoot, item);
        const bundleItemPath = path.join(bundleRoot, item);
        const rootExists = fs.existsSync(rootItemPath);
        const bundleExists = fs.existsSync(bundleItemPath);
        const rootHash = rootExists ? hashSurfaceItem(rootItemPath) : null;
        const bundleHash = bundleExists ? hashSurfaceItem(bundleItemPath) : null;

        itemResults.push({ item, rootExists, bundleExists, rootHash, bundleHash });
        if (!rootExists || !bundleExists) {
            violations.push(`${item}: missing root=${rootExists} bundle=${bundleExists}`);
            continue;
        }
        if (rootHash !== bundleHash) {
            violations.push(`${item}: hash mismatch`);
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
        lines.push('Remediation: select at least one parity item and refresh a non-ignored embedded bundle from the root source before release.');
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
